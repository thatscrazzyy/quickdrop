// quickdrop/src/App.jsx

import React, { useState, useCallback, useEffect } from 'react';

// --- Configuration ---
// This is your local API server. When you deploy, change this.
const API_BASE_URL = 'http://localhost:8080';

// --- Helper Functions ---
/**
 * Formats file size in bytes to a human-readable string.
 */
const formatBytes = (bytes, decimals = 2) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};

/**
 * Uses XMLHttpRequest to upload a file to a signed URL
 * while providing progress updates. This is better than fetch()
 * for an "upload manager" as it gives progress.
 */
const uploadFileWithProgress = (file, uploadUrl, onProgress) => {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl, true);
    xhr.setRequestHeader('Content-Type', file.type);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        const progress = (event.loaded / event.total) * 100;
        onProgress(progress);
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response);
      } else {
        reject(new Error(`Upload failed with status: ${xhr.status}`));
      }
    };

    xhr.onerror = () => {
      reject(new Error('Upload failed due to network error.'));
    };

    xhr.send(file);
  });
};

// --- React App Component ---
export default function App() {
  // App state
  const [sessionId, setSessionId] = useState(null);
  const [joinInput, setJoinInput] = useState('');
  const [files, setFiles] = useState([]); // Holds the file list
  const [uploadingFiles, setUploadingFiles] = useState({}); // { [fileName]: progress }
  const [appError, setAppError] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  // --- Sprint 2: Real-Time Event Listener ---
  useEffect(() => {
    if (!sessionId) {
      setFiles([]); // Clear files when not in a session
      return;
    }

    // 1. Subscribe to Server-Sent Events (SSE)
    console.log(`Connecting to SSE for session: ${sessionId}`);
    const eventSource = new EventSource(
      `${API_BASE_URL}/api/sessions/${sessionId}/subscribe`
    );

    // 2. Handle incoming messages
    eventSource.onmessage = (event) => {
      try {
        const fileData = JSON.parse(event.data);
        console.log('SSE message received:', fileData);
        setFiles((prevFiles) => {
          // Avoid adding duplicates
          if (prevFiles.find(f => f.id === fileData.id)) {
            return prevFiles;
          }
          // Add new file to top of list, sorted by time
          const newList = [fileData, ...prevFiles];
          newList.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
          return newList;
        });
      } catch (e) {
        console.error("Failed to parse SSE message data", e)
      }
    };

    // 3. Handle errors
    eventSource.onerror = (err) => {
      console.error('EventSource error:', err);
      setAppError('Connection to real-time server lost.');
      eventSource.close();
    };

    // 4. Cleanup when component unmounts or sessionId changes
    return () => {
      console.log('Closing SSE connection.');
      eventSource.close();
    };
  }, [sessionId]); // Re-run this effect whenever sessionId changes

  // 1. Handle creating a new session
  const handleCreateSession = async () => {
    setIsLoading(true);
    setAppError(null);
    try {
      const response = await fetch(`${API_BASE_URL}/api/create-session`, {
        method: 'POST',
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.message || 'Failed to create session on server.');
      }
      const data = await response.json();
      setSessionId(data.sessionId);
    } catch (error) {
      console.error(error);
      setAppError(error.message);
    }
    setIsLoading(false);
  };

  // 2. Handle joining an existing session
  const handleJoinSession = (e) => {
    e.preventDefault();
    if (joinInput.trim()) {
      setSessionId(joinInput.trim());
    }
  };

  // 3. Handle leaving a session
  const handleLeaveSession = () => {
    setSessionId(null);
    setJoinInput('');
    setAppError(null);
    setUploadingFiles({});
  };

  // 4. Handle file upload (from drop or input)
  const handleFileUpload = useCallback(async (droppedFiles) => {
    if (!sessionId) {
      setAppError("Not in a session. Cannot upload files.");
      return;
    }

    const MAX_SIZE = 100 * 1024 * 1024; // 100MB

    for (const file of droppedFiles) {
      const uniqueFileName = `${Date.now()}-${file.name}`;
      
      if (file.size > MAX_SIZE) {
        setAppError(`File ${file.name} is too large (Max 100MB).`);
        continue;
      }

      setUploadingFiles(prev => ({ ...prev, [uniqueFileName]: 0 }));

      try {
        // --- This is the Sprint 1 Upload Flow ---
        
        // 1. Ask our backend for a signed URL
        const urlResponse = await fetch(`${API_BASE_URL}/api/get-upload-url`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: sessionId,
            fileName: file.name,
            fileType: file.type,
            fileSize: file.size,
          }),
        });

        if (!urlResponse.ok) {
          const err = await urlResponse.json();
          throw new Error(err.message || 'Failed to get upload URL.');
        }

        const { uploadUrl } = await urlResponse.json();

        // 2. Upload the file directly to GCS using the signed URL
        await uploadFileWithProgress(file, uploadUrl, (progress) => {
          setUploadingFiles(prev => ({ ...prev, [uniqueFileName]: progress }));
        });

        // 3. Upload is complete!
        console.log(`Upload complete: ${file.name}`);
        
        // Remove from uploading state
        // We add a small delay so the 100% bar is visible
        setTimeout(() => {
          setUploadingFiles(prev => {
            const newState = { ...prev };
            delete newState[uniqueFileName];
            return newState;
          });
        }, 500);
        
        // ** NOTE **
        // The Cloud Function is now processing this file.
        // Our SSE listener will pick up the "file-ready" event
        // and add the file to the list.

      } catch (error) {
        console.error("Upload error:", error);
        setAppError(`Failed to upload ${file.name}: ${error.message}`);
        setUploadingFiles(prev => {
          const newState = { ...prev };
          delete newState[uniqueFileName];
          return newState;
        });
      }
    }
  }, [sessionId]);

  // --- Sprint 2: Download Handler ---
  const handleDownload = async (file) => {
    try {
      // 1. Ask our backend for a temporary download link
      const response = await fetch(
        `${API_BASE_URL}/api/get-download-url?storagePath=${file.storagePath}`
      );
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.message || 'Could not get download link.');
      }
      const { downloadUrl } = await response.json();

      // 2. Open the link to trigger download
      window.open(downloadUrl, '_blank');

    } catch (error) {
      console.error('Download error:', error);
      setAppError(error.message);
    }
  };


  // 5. Drag-and-drop event handlers
  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragging(true);
  };
  const handleDragLeave = (e) => {
    e.preventDefault();
    setIsDragging(false);
  };
  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFileUpload(e.dataTransfer.files);
      e.dataTransfer.clearData();
    }
  };
  
  // --- Render Logic ---

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-900 text-white">
        <div className="text-2xl font-semibold">Loading...</div>
      </div>
    );
  }

  if (appError) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-900 text-white p-4">
        <div className="bg-red-800 border border-red-600 p-6 rounded-lg shadow-xl text-center">
          <h2 className="text-2xl font-bold mb-4">An Error Occurred</h2>
          <p className="text-red-100">{appError}</p>
          <button
            onClick={() => { setAppError(null); handleLeaveSession(); }}
            className="mt-6 px-4 py-2 bg-red-600 hover:bg-red-500 rounded-md font-semibold text-white shadow-lg transition-all"
          >
            Go Home
          </button>
        </div>
      </div>
    );
  }
  
  const uploadingList = Object.entries(uploadingFiles);

  return (
    <div className="flex flex-col min-h-screen bg-gray-900 text-gray-100 font-sans p-4 md:p-8">
      <header className="w-full max-w-5xl mx-auto mb-6">
        <h1 className="text-4xl font-bold text-center text-white">
          <span className="text-cyan-400">Quick</span>Drop
        </h1>
        <p className="text-center text-lg text-gray-400">
          Real-Time File Sharing
        </p>
      </header>

      {!sessionId ? (
        // --- Session Join/Create View ---
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
          </div>
        </div>
      ) : (
        // --- File Share View ---
        <div className="flex-grow flex flex-col w-full max-w-5xl mx-auto">
          <div className="flex flex-col sm:flex-row justify-between items-center mb-4 p-4 bg-gray-800 rounded-lg border border-gray-700">
            <div className="mb-2 sm:mb-0">
              <span className="text-gray-400">Session Code: </span>
              <strong className="text-lg text-cyan-400 font-mono">{sessionId}</strong>
            </div>
            <button
              onClick={handleLeaveSession}
              className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white font-semibold rounded-lg shadow-md transition-colors text-sm"
            >
              Leave Session
            </button>
          </div>
          
          {/* --- Drop Zone --- */}
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`relative flex flex-col items-center justify-center p-10 border-4 border-dashed rounded-xl transition-all ${isDragging ? 'border-cyan-400 bg-gray-700' : 'border-gray-600 bg-gray-800'}`}
          >
            <input
              type="file"
              multiple
              onChange={(e) => handleFileUpload(e.target.files)}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              aria-label="File upload"
            />
            <svg className="w-16 h-16 text-gray-500 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-4-4V7a4 4 0 014-4h.5a3.5 3.5 0 013.5 3.5v1.5a3.5 3.5 0 01-3.5 3.5H7zM10 7a4 4 0 11-8 0 4 4 0 018 0zM17 16a4 4 0 01-4-4V7a4 4 0 014-4h.5a3.5 3.5 0 013.5 3.5v1.5a3.5 3.5 0 01-3.5 3.5H17zM14 7a4 4 0 11-8 0 4 4 0 018 0z" /></svg>
            <p className="text-xl text-gray-300">Drag & Drop files here</p>
            <p className="text-gray-400">or click to select files</p>
            <p className="text-sm text-gray-500 mt-2">(Max 100MB per file)</p>
          </div>
          
          {/* --- Uploading Files --- */}
          {uploadingList.length > 0 && (
            <div className="my-4 p-4 bg-gray-800 rounded-lg">
              <h3 className="text-lg font-semibold mb-2 text-cyan-400">Uploading...</h3>
              <div className="space-y-3">
                {uploadingList.map(([name, progress]) => (
                  <div key={name}>
                    <div className="flex justify-between text-sm text-gray-300 mb-1">
                      <span className="truncate w-11/12">{name.split('-').slice(1).join('-')}</span>
                      <span>{Math.round(progress)}%</span>
                    </div>
                    <div className="w-full bg-gray-600 rounded-full h-2.5">
                      <div className="bg-cyan-500 h-2.5 rounded-full" style={{ width: `${progress}%` }}></div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          
          {/* --- Shared Files List --- */}
          <div className="flex-grow mt-6">
            <h3 className="text-xl font-semibold mb-4 text-gray-300">Shared Files</h3>
            <div className="space-y-3">
              {files.length === 0 && uploadingList.length === 0 && (
                <p className="text-gray-500 text-center py-4">
                  No files shared in this session yet. Upload one!
                </p>
              )}
              {files.map(file => (
                <div key={file.id} className="flex items-center justify-between p-4 bg-gray-800 rounded-lg border border-gray-700">
                  <div>
                    <p className="text-lg font-medium text-cyan-300 truncate w-60 sm:w-full">{file.name}</p>
                    <p className="text-sm text-gray-400">{formatBytes(file.size)} - {file.type}</p>
                  </div>
                  <button
                    onClick={() => handleDownload(file)}
                    className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white font-semibold rounded-lg shadow-md transition-colors text-sm ml-2"
                  >
                    Download
                  </button>
                </div>
              ))}
            </div>
          </div>
          
        </div>
      )}
    </div>
  );
}