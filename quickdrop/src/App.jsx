// quickdrop/src/App.jsx

import React, { useState, useCallback, useEffect, useRef } from 'react';
import JSZip from 'jszip';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080';

// --- Helpers ---

const formatBytes = (bytes, decimals = 2) => {
  if (!bytes || bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};

const uploadFileWithProgress = (blob, uploadUrl, contentType, onProgress) =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl, true);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress((e.loaded / e.total) * 100);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Upload failed (${xhr.status})`));
    xhr.onerror = () => reject(new Error('Upload failed: network error'));
    xhr.send(blob);
  });

// Returns 'image' | 'video' | 'audio' | 'pdf' | null
const getPreviewType = (mimeType) => {
  if (!mimeType) return null;
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType === 'application/pdf') return 'pdf';
  return null;
};

// --- Crypto ---

const generateEncKey = () =>
  crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);

const exportKeyB64 = async (key) => {
  const raw = await crypto.subtle.exportKey('raw', key);
  return btoa(String.fromCharCode(...new Uint8Array(raw)));
};

const importKeyB64 = (b64) => {
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
};

const encryptFileData = async (file, key) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await file.arrayBuffer();
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  const out = new Uint8Array(12 + cipher.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(cipher), 12);
  return new Blob([out]);
};

const decryptFileData = async (encryptedBlob, key, originalType) => {
  const buf = await encryptedBlob.arrayBuffer();
  const iv = new Uint8Array(buf, 0, 12);
  const ciphertext = buf.slice(12);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new Blob([plain], { type: originalType || 'application/octet-stream' });
};

// Fetch a file from GCS and decrypt it if a key is available
const fetchAndDecrypt = async (file, apiBase, encKey) => {
  const resp = await fetch(
    `${apiBase}/api/get-download-url?storagePath=${encodeURIComponent(file.storagePath)}`
  );
  if (!resp.ok) throw new Error('Could not get download link.');
  const { downloadUrl } = await resp.json();
  const raw = await fetch(downloadUrl);
  const blob = await raw.blob();
  return encKey ? decryptFileData(blob, encKey, file.type) : blob;
};

// --- Toast ---

function ToastStack({ toasts, onDismiss }) {
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none">
      {toasts.map(({ id, message, type }) => (
        <div
          key={id}
          className={`flex items-start justify-between gap-3 px-4 py-3 rounded-lg shadow-xl border text-sm font-medium pointer-events-auto ${
            type === 'error'
              ? 'bg-red-900 border-red-600 text-red-100'
              : type === 'success'
              ? 'bg-green-900 border-green-600 text-green-100'
              : 'bg-gray-700 border-gray-500 text-gray-100'
          }`}
        >
          <span>{message}</span>
          <button
            onClick={() => onDismiss(id)}
            className="opacity-70 hover:opacity-100 flex-shrink-0 leading-none"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

// --- Preview Modal ---

function PreviewModal({ file, previewUrl, loading, onClose }) {
  // Close on Escape key
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  if (!file) return null;
  const type = getPreviewType(file.type);

  return (
    <div
      className="fixed inset-0 bg-black/85 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-4xl max-h-[90vh] flex flex-col bg-gray-900 rounded-xl overflow-hidden shadow-2xl border border-gray-700"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700 flex-shrink-0">
          <div className="min-w-0 mr-4">
            <p className="font-medium text-gray-200 truncate">{file.name}</p>
            <p className="text-xs text-gray-500">{formatBytes(file.size)}</p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors flex-shrink-0 p-1"
            aria-label="Close preview"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto flex items-center justify-center p-4 min-h-0">
          {loading ? (
            <div className="flex flex-col items-center gap-3 text-gray-400 py-16">
              <div className="w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-sm">Decrypting {formatBytes(file.size)}…</span>
            </div>
          ) : !previewUrl ? (
            <p className="text-gray-500 py-16">Preview unavailable.</p>
          ) : type === 'image' ? (
            <img
              src={previewUrl}
              alt={file.name}
              className="max-w-full max-h-[70vh] object-contain rounded"
            />
          ) : type === 'video' ? (
            <video
              src={previewUrl}
              controls
              autoPlay
              className="max-w-full max-h-[70vh] rounded"
            />
          ) : type === 'audio' ? (
            <div className="w-full max-w-lg py-8">
              <p className="text-gray-400 text-sm text-center mb-4">{file.name}</p>
              <audio src={previewUrl} controls className="w-full" />
            </div>
          ) : type === 'pdf' ? (
            <iframe
              src={previewUrl}
              title={file.name}
              className="w-full rounded"
              style={{ height: '70vh' }}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

// --- App ---

export default function App() {
  const [sessionId, setSessionId] = useState(null);
  const [joinInput, setJoinInput] = useState('');
  const [files, setFiles] = useState([]);
  const [uploadingFiles, setUploadingFiles] = useState({});
  const [toasts, setToasts] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [encKey, setEncKey] = useState(null);
  const [encKeyB64, setEncKeyB64] = useState(null);
  const [expiresAt, setExpiresAt] = useState(null);
  const [timeLeft, setTimeLeft] = useState(null);
  const [deletingFiles, setDeletingFiles] = useState(new Set());

  // Multi-select
  const [selectedFiles, setSelectedFiles] = useState(new Set());
  const [isZipping, setIsZipping] = useState(false);

  // Preview
  const [previewFile, setPreviewFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef(null);
  const eventSourceRef = useRef(null);

  const addToast = useCallback((message, type = 'error') => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5000);
  }, []);

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Bootstrap from URL on mount
  useEffect(() => {
    const init = async () => {
      const params = new URLSearchParams(window.location.search);
      const urlSession = params.get('session');
      const hash = window.location.hash;
      const keyMatch = hash.match(/[#&]k=([A-Za-z0-9+/=]+)/);

      if (keyMatch) {
        try {
          const key = await importKeyB64(keyMatch[1]);
          setEncKey(key);
          setEncKeyB64(keyMatch[1]);
        } catch {
          console.error('Could not import encryption key from URL');
        }
      }

      if (urlSession) {
        try {
          const resp = await fetch(`${API_BASE_URL}/api/sessions/${urlSession.trim()}/validate`);
          if (resp.ok) {
            const { expiresAt: exp } = await resp.json();
            setExpiresAt(exp);
            setSessionId(urlSession.trim());
            setJoinInput(urlSession.trim());
          } else {
            addToast('Session not found or expired.', 'error');
            window.history.replaceState({}, '', window.location.pathname);
          }
        } catch {
          setSessionId(urlSession.trim());
          setJoinInput(urlSession.trim());
        }
      }
    };
    init();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Session expiry countdown
  useEffect(() => {
    if (!expiresAt) { setTimeLeft(null); return; }
    const tick = () => {
      const diff = new Date(expiresAt) - Date.now();
      if (diff <= 0) { setTimeLeft('Expired'); return; }
      const m = Math.floor(diff / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setTimeLeft(`${m}m ${String(s).padStart(2, '0')}s`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  // SSE connection with auto-reconnect
  const connectSSE = useCallback(() => {
    if (!sessionId) return;
    const es = new EventSource(`${API_BASE_URL}/api/sessions/${sessionId}/subscribe`);
    eventSourceRef.current = es;
    es.onmessage = (event) => {
      try {
        const fileData = JSON.parse(event.data);
        setFiles((prev) => {
          if (prev.find((f) => f.id === fileData.id)) return prev;
          const next = [fileData, ...prev];
          next.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
          return next;
        });
      } catch {
        console.error('Failed to parse SSE message');
      }
    };
    es.onerror = () => {
      es.close();
      const attempts = reconnectAttemptsRef.current;
      if (attempts >= 5) {
        addToast('Lost real-time connection. Refresh to reconnect.', 'error');
        return;
      }
      const delay = Math.min(1000 * Math.pow(2, attempts), 30000);
      reconnectAttemptsRef.current += 1;
      reconnectTimerRef.current = setTimeout(connectSSE, delay);
    };
  }, [sessionId, addToast]);

  // Load files + open SSE on session join
  useEffect(() => {
    if (!sessionId) { setFiles([]); return; }
    reconnectAttemptsRef.current = 0;
    clearTimeout(reconnectTimerRef.current);
    if (eventSourceRef.current) eventSourceRef.current.close();

    fetch(`${API_BASE_URL}/api/sessions/${sessionId}/files`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        setFiles((prev) => {
          const combined = [...data.files, ...prev];
          const seen = new Set();
          return combined
            .filter((f) => { if (seen.has(f.id)) return false; seen.add(f.id); return true; })
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        });
      })
      .catch(console.error);

    connectSSE();
    return () => {
      clearTimeout(reconnectTimerRef.current);
      if (eventSourceRef.current) { eventSourceRef.current.close(); eventSourceRef.current = null; }
    };
  }, [sessionId, connectSSE]);

  // Sync URL with session + key
  useEffect(() => {
    const url = new URL(window.location.href);
    if (sessionId) {
      url.searchParams.set('session', sessionId);
      url.hash = encKeyB64 ? `k=${encKeyB64}` : '';
    } else {
      url.searchParams.delete('session');
      url.hash = '';
    }
    window.history.replaceState({}, '', url);
  }, [sessionId, encKeyB64]);

  // --- Session actions ---

  const handleCreateSession = async () => {
    setIsLoading(true);
    try {
      const resp = await fetch(`${API_BASE_URL}/api/create-session`, { method: 'POST' });
      if (!resp.ok) throw new Error('Failed to create session.');
      const { sessionId: newId, expiresAt: exp } = await resp.json();
      const key = await generateEncKey();
      const keyB64 = await exportKeyB64(key);
      setEncKey(key);
      setEncKeyB64(keyB64);
      setExpiresAt(exp);
      setSessionId(newId);
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleJoinSession = async (e) => {
    e.preventDefault();
    if (!joinInput.trim()) return;
    setIsLoading(true);
    try {
      const resp = await fetch(`${API_BASE_URL}/api/sessions/${joinInput.trim()}/validate`);
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.message || 'Session not found.');
      }
      const { expiresAt: exp } = await resp.json();
      setExpiresAt(exp);
      setSessionId(joinInput.trim());
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const clearSession = () => {
    clearTimeout(reconnectTimerRef.current);
    if (eventSourceRef.current) { eventSourceRef.current.close(); eventSourceRef.current = null; }
    setSessionId(null);
    setJoinInput('');
    setEncKey(null);
    setEncKeyB64(null);
    setExpiresAt(null);
    setUploadingFiles({});
    setFiles([]);
    setSelectedFiles(new Set());
    closePreview();
  };

  const handleLeaveSession = () => clearSession();

  const handleEndSession = async () => {
    if (!confirm('End this session? All files will be permanently deleted.')) return;
    try {
      const resp = await fetch(`${API_BASE_URL}/api/sessions/${sessionId}`, { method: 'DELETE' });
      if (!resp.ok) throw new Error('Failed to end session.');
      clearSession();
      addToast('Session ended. All files deleted.', 'success');
    } catch (err) {
      addToast(err.message, 'error');
    }
  };

  const handleDeleteFile = async (file) => {
    setDeletingFiles((prev) => new Set(prev).add(file.id));
    try {
      const resp = await fetch(
        `${API_BASE_URL}/api/sessions/${sessionId}/files/${file.id}`,
        { method: 'DELETE' }
      );
      if (!resp.ok) throw new Error('Failed to delete file.');
      setFiles((prev) => prev.filter((f) => f.id !== file.id));
      setSelectedFiles((prev) => { const next = new Set(prev); next.delete(file.id); return next; });
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setDeletingFiles((prev) => { const next = new Set(prev); next.delete(file.id); return next; });
    }
  };

  // --- Upload ---

  const handleFileUpload = useCallback(
    async (droppedFiles) => {
      if (!sessionId) { addToast('Not in a session.', 'error'); return; }
      const MAX_SIZE = 100 * 1024 * 1024;

      for (const file of droppedFiles) {
        if (file.size > MAX_SIZE) { addToast(`${file.name} exceeds 100MB limit.`, 'error'); continue; }

        const uid = `${Date.now()}-${file.name}`;
        setUploadingFiles((prev) => ({ ...prev, [uid]: 0 }));

        try {
          const uploadBlob = encKey ? await encryptFileData(file, encKey) : file;

          const urlResp = await fetch(`${API_BASE_URL}/api/get-upload-url`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, fileName: file.name, fileType: file.type, fileSize: file.size }),
          });
          if (!urlResp.ok) {
            const err = await urlResp.json().catch(() => ({}));
            throw new Error(err.message || 'Failed to get upload URL.');
          }
          const { uploadUrl } = await urlResp.json();

          await uploadFileWithProgress(uploadBlob, uploadUrl, file.type, (p) =>
            setUploadingFiles((prev) => ({ ...prev, [uid]: p }))
          );

          setTimeout(() =>
            setUploadingFiles((prev) => { const next = { ...prev }; delete next[uid]; return next; }), 500
          );
        } catch (err) {
          addToast(`Upload failed for ${file.name}: ${err.message}`, 'error');
          setUploadingFiles((prev) => { const next = { ...prev }; delete next[uid]; return next; });
        }
      }
    },
    [sessionId, encKey, addToast]
  );

  // --- Download ---

  const handleDownload = async (file) => {
    try {
      const blob = await fetchAndDecrypt(file, API_BASE_URL, encKey);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name || 'download';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      addToast(`Download failed: ${err.message}`, 'error');
    }
  };

  // --- ZIP Download ---

  const handleZipDownload = async (targetFiles) => {
    if (targetFiles.length === 0) return;
    setIsZipping(true);
    addToast(`Preparing ZIP for ${targetFiles.length} file${targetFiles.length > 1 ? 's' : ''}…`, 'info');
    const zip = new JSZip();
    try {
      await Promise.all(
        targetFiles.map(async (file) => {
          const blob = await fetchAndDecrypt(file, API_BASE_URL, encKey);
          zip.file(file.name, await blob.arrayBuffer());
        })
      );
      const content = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
      const url = URL.createObjectURL(content);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'quickdrop-files.zip';
      a.click();
      URL.revokeObjectURL(url);
      setSelectedFiles(new Set());
    } catch (err) {
      addToast(`ZIP download failed: ${err.message}`, 'error');
    } finally {
      setIsZipping(false);
    }
  };

  // --- Preview ---

  const openPreview = async (file) => {
    setPreviewFile(file);
    setPreviewUrl(null);
    setPreviewLoading(true);
    try {
      const blob = await fetchAndDecrypt(file, API_BASE_URL, encKey);
      setPreviewUrl(URL.createObjectURL(blob));
    } catch (err) {
      addToast(`Preview failed: ${err.message}`, 'error');
      setPreviewFile(null);
    } finally {
      setPreviewLoading(false);
    }
  };

  const closePreview = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewFile(null);
    setPreviewUrl(null);
    setPreviewLoading(false);
  };

  // --- Copy link ---

  const handleCopyLink = async () => {
    const url = sessionId
      ? `${window.location.origin}?session=${encodeURIComponent(sessionId)}${encKeyB64 ? `#k=${encKeyB64}` : ''}`
      : '';
    try {
      await navigator.clipboard.writeText(url);
      addToast('Link copied!', 'success');
    } catch {
      addToast('Could not copy link.', 'error');
    }
  };

  // --- Drag handlers ---

  const handleDragOver = (e) => { e.preventDefault(); setIsDragging(true); };
  const handleDragLeave = (e) => { e.preventDefault(); setIsDragging(false); };
  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files?.length > 0) {
      handleFileUpload(e.dataTransfer.files);
      e.dataTransfer.clearData();
    }
  };

  // --- Selection helpers ---

  const allSelected = files.length > 0 && files.every((f) => selectedFiles.has(f.id));
  const toggleSelectAll = () =>
    setSelectedFiles(allSelected ? new Set() : new Set(files.map((f) => f.id)));
  const toggleSelect = (id) =>
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const sessionUrl = sessionId
    ? `${window.location.origin}?session=${encodeURIComponent(sessionId)}${encKeyB64 ? `#k=${encKeyB64}` : ''}`
    : '';

  const uploadingList = Object.entries(uploadingFiles);
  const selectedList = files.filter((f) => selectedFiles.has(f.id));

  // --- Render ---

  return (
    <div className="flex flex-col min-h-screen bg-gray-900 text-gray-100 font-sans p-4 md:p-8">
      <ToastStack toasts={toasts} onDismiss={dismissToast} />

      {previewFile && (
        <PreviewModal
          file={previewFile}
          previewUrl={previewUrl}
          loading={previewLoading}
          onClose={closePreview}
        />
      )}

      <header className="w-full max-w-5xl mx-auto mb-6">
        <h1 className="text-4xl font-bold text-center text-white">
          <span className="text-cyan-400">Quick</span>Drop
        </h1>
        <p className="text-center text-lg text-gray-400">Real-Time File Sharing</p>
      </header>

      {isLoading ? (
        <div className="flex-grow flex items-center justify-center">
          <div className="text-2xl font-semibold text-gray-400 animate-pulse">Loading...</div>
        </div>
      ) : !sessionId ? (
        // --- Home view ---
        <div className="flex-grow flex items-center justify-center">
          <div className="w-full max-w-md bg-gray-800 p-8 rounded-2xl shadow-2xl border border-gray-700">
            <h2 className="text-2xl font-semibold text-center mb-6">Get Started</h2>
            <button
              onClick={handleCreateSession}
              className="w-full px-6 py-3 bg-cyan-600 hover:bg-cyan-500 text-white font-bold rounded-lg shadow-lg text-lg transition-transform transform hover:scale-105"
            >
              Create New Session
            </button>
            <div className="my-6 flex items-center">
              <hr className="flex-grow border-gray-600" />
              <span className="mx-4 text-gray-400">OR</span>
              <hr className="flex-grow border-gray-600" />
            </div>
            <form onSubmit={handleJoinSession} className="space-y-4">
              <input
                type="text"
                value={joinInput}
                onChange={(e) => setJoinInput(e.target.value)}
                placeholder="Enter 6-digit code"
                className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                aria-label="Session code"
              />
              <button
                type="submit"
                className="w-full px-6 py-3 bg-gray-600 hover:bg-gray-500 text-white font-semibold rounded-lg shadow-md transition-colors"
              >
                Join Session
              </button>
            </form>
            <p className="text-xs text-gray-500 text-center mt-4">
              Sessions auto-delete after 1 hour. Files are end-to-end encrypted when shared via link.
            </p>
          </div>
        </div>
      ) : (
        // --- Session view ---
        <div className="flex-grow flex flex-col w-full max-w-5xl mx-auto">
          {/* Session header */}
          <div className="flex flex-col sm:flex-row justify-between sm:items-start mb-4 p-4 bg-gray-800 rounded-lg border border-gray-700 gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-gray-400 text-sm">Session:</span>
                <strong className="text-xl text-cyan-400 font-mono tracking-widest">{sessionId}</strong>
                {encKey ? (
                  <span className="text-xs bg-green-900 text-green-300 px-2 py-0.5 rounded-full border border-green-700">
                    E2E Encrypted
                  </span>
                ) : (
                  <span className="text-xs bg-yellow-900 text-yellow-300 px-2 py-0.5 rounded-full border border-yellow-700">
                    No Key — Use Full Link to Decrypt
                  </span>
                )}
              </div>
              {timeLeft && (
                <p className="text-xs text-gray-500 mt-1">
                  Expires:{' '}
                  <span className={timeLeft === 'Expired' ? 'text-red-400 font-semibold' : 'text-gray-300'}>
                    {timeLeft}
                  </span>
                </p>
              )}
              {sessionUrl && (
                <p className="text-xs text-gray-500 mt-1 break-all leading-relaxed">{sessionUrl}</p>
              )}
            </div>

            <div className="flex items-start gap-3 flex-shrink-0">
              {sessionUrl && (
                <div className="flex flex-col items-center">
                  <span className="text-xs text-gray-400 mb-1">Scan to join</span>
                  <div className="bg-white p-1.5 rounded-lg">
                    <img
                      src={`https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(sessionUrl)}`}
                      alt="Session QR code"
                      className="w-20 h-20 block"
                    />
                  </div>
                </div>
              )}
              <div className="flex flex-col gap-2">
                <button
                  onClick={handleCopyLink}
                  className="px-3 py-2 bg-gray-600 hover:bg-gray-500 text-white font-semibold rounded-lg text-sm transition-colors"
                >
                  Copy Link
                </button>
                <button
                  onClick={handleLeaveSession}
                  className="px-3 py-2 bg-gray-600 hover:bg-gray-500 text-white font-semibold rounded-lg text-sm transition-colors"
                >
                  Leave
                </button>
                <button
                  onClick={handleEndSession}
                  className="px-3 py-2 bg-red-700 hover:bg-red-600 text-white font-semibold rounded-lg text-sm transition-colors"
                >
                  End Session
                </button>
              </div>
            </div>
          </div>

          {/* Drop zone */}
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`relative flex flex-col items-center justify-center p-10 border-4 border-dashed rounded-xl transition-all ${
              isDragging ? 'border-cyan-400 bg-gray-700' : 'border-gray-600 bg-gray-800'
            }`}
          >
            <input
              type="file"
              multiple
              onChange={(e) => handleFileUpload(e.target.files)}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              aria-label="File upload"
            />
            <svg className="w-14 h-14 text-gray-500 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
            <p className="text-xl text-gray-300">Drag & drop files here</p>
            <p className="text-gray-400">or click to select</p>
            <p className="text-sm text-gray-500 mt-2">Max 100MB per file</p>
          </div>

          {/* Upload progress */}
          {uploadingList.length > 0 && (
            <div className="mt-4 p-4 bg-gray-800 rounded-lg border border-gray-700">
              <h3 className="text-base font-semibold mb-3 text-cyan-400">Uploading…</h3>
              <div className="space-y-3">
                {uploadingList.map(([uid, progress]) => (
                  <div key={uid}>
                    <div className="flex justify-between text-sm text-gray-300 mb-1">
                      <span className="truncate w-11/12">{uid.replace(/^\d+-/, '')}</span>
                      <span>{Math.round(progress)}%</span>
                    </div>
                    <div className="w-full bg-gray-600 rounded-full h-2">
                      <div
                        className="bg-cyan-500 h-2 rounded-full transition-all duration-150"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* File list */}
          <div className="flex-grow mt-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <h3 className="text-xl font-semibold text-gray-300">Shared Files</h3>
                {files.length > 0 && (
                  <button
                    onClick={toggleSelectAll}
                    className="text-xs text-gray-400 hover:text-cyan-400 transition-colors"
                  >
                    {allSelected ? 'Deselect All' : 'Select All'}
                  </button>
                )}
              </div>

              {files.length > 0 && (
                <button
                  onClick={() =>
                    selectedList.length > 0
                      ? handleZipDownload(selectedList)
                      : handleZipDownload(files)
                  }
                  disabled={isZipping}
                  className="flex items-center gap-1.5 px-3 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white font-semibold rounded-lg text-sm transition-colors border border-gray-600"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  {isZipping
                    ? 'Zipping…'
                    : selectedList.length > 0
                    ? `Download ZIP (${selectedList.length})`
                    : 'Download All as ZIP'}
                </button>
              )}
            </div>

            <div className="space-y-2">
              {files.length === 0 && uploadingList.length === 0 && (
                <p className="text-gray-500 text-center py-10">No files yet — upload one above!</p>
              )}
              {files.map((file) => {
                const canPreview = !!getPreviewType(file.type);
                const isSelected = selectedFiles.has(file.id);
                return (
                  <div
                    key={file.id}
                    className={`flex items-center gap-3 p-3 rounded-lg border transition-colors ${
                      isSelected
                        ? 'bg-gray-700 border-cyan-700'
                        : 'bg-gray-800 border-gray-700 hover:border-gray-600'
                    }`}
                  >
                    {/* Checkbox */}
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelect(file.id)}
                      className="w-4 h-4 accent-cyan-500 flex-shrink-0 cursor-pointer"
                      aria-label={`Select ${file.name}`}
                    />

                    {/* File info */}
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-cyan-300 truncate">{file.name}</p>
                      <p className="text-sm text-gray-400">
                        {formatBytes(file.size)}
                        {file.type ? ` · ${file.type}` : ''}
                      </p>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {canPreview && (
                        <button
                          onClick={() => openPreview(file)}
                          className="p-2 text-gray-400 hover:text-cyan-400 rounded-lg hover:bg-gray-700 transition-colors"
                          title="Preview"
                          aria-label="Preview file"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                          </svg>
                        </button>
                      )}
                      <button
                        onClick={() => handleDownload(file)}
                        className="px-3 py-2 bg-cyan-600 hover:bg-cyan-500 text-white font-semibold rounded-lg text-sm transition-colors"
                      >
                        Download
                      </button>
                      <button
                        onClick={() => handleDeleteFile(file)}
                        disabled={deletingFiles.has(file.id)}
                        className="p-2 text-gray-500 hover:text-red-400 disabled:opacity-40 rounded-lg hover:bg-gray-700 transition-colors"
                        title="Delete file"
                        aria-label="Delete file"
                      >
                        {deletingFiles.has(file.id) ? (
                          <span className="text-xs w-4 h-4 flex items-center justify-center">…</span>
                        ) : (
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        )}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
