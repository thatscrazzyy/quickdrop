import React, { useState, useEffect, useCallback, useRef } from 'react';

// Firebase imports (as per instructions)
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { 
  getFirestore, 
  doc, 
  onSnapshot, 
  serverTimestamp,
  setLogLevel,
  collection,
  addDoc,
  query
} from 'firebase/firestore';
import {
  getStorage,
  ref,
  uploadBytesResumable,
  getDownloadURL
} from 'firebase/storage';

// --- Firebase Configuration ---
// Read config from Vite environment variables (.env.local)
const firebaseConfig = import.meta.env.VITE_FIREBASE_CONFIG_JSON 
  ? JSON.parse(import.meta.env.VITE_FIREBASE_CONFIG_JSON)
  : {};
const appId = import.meta.env.VITE_APP_ID || 'default-app-id';
const initialAuthToken = import.meta.env.VITE_INITIAL_AUTH_TOKEN || null;

// --- Helper Functions ---
/**
 * Generates a user-friendly 3-word random ID.
 */
const generateFriendlyId = () => {
  const adjectives = ['swift', 'quick', 'fast', 'red', 'blue', 'green', 'cold', 'hot', 'dark', 'light', 'big', 'tiny'];
  const nouns = ['fox', 'cat', 'dog', 'bird', 'sky', 'sea', 'rock', 'tree', 'sun', 'moon', 'star', 'leaf'];
  const numbers = Math.floor(Math.random() * 90) + 10; // 10-99

  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  
  return `${adj}-${noun}-${numbers}`;
};

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

// --- React App Component ---
export default function App() {
  // Firebase state
  const [db, setDb] = useState(null);
  const [auth, setAuth] = useState(null);
  const [storage, setStorage] = useState(null);
  const [userId, setUserId] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  
  // App state
  const [sessionId, setSessionId] = useState(null);
  const [joinInput, setJoinInput] = useState('');
  const [files, setFiles] = useState([]); // List of files in the session
  const [uploadingFiles, setUploadingFiles] = useState({}); // { [fileName]: progress }
  const [appError, setAppError] = useState(null);
  const [isDragging, setIsDragging] = useState(false);

  // 1. Initialize Firebase and Authenticate User
  useEffect(() => {
    try {
      if (Object.keys(firebaseConfig).length === 0) {
        console.error("Firebase config is empty.");
        setAppError("App is not configured. Please check console.");
        setIsLoading(false);
        return;
      }

      setLogLevel('Debug');
      const app = initializeApp(firebaseConfig);
      const authInstance = getAuth(app);
      const dbInstance = getFirestore(app);
      const storageInstance = getStorage(app); // Initialize Storage
      
      setDb(dbInstance);
      setAuth(authInstance);
      setStorage(storageInstance);

      // Auth state listener
      const unsubscribe = onAuthStateChanged(authInstance, async (user) => {
        if (user) {
          setUserId(user.uid);
          setIsLoading(false);
          console.log("User is signed in with UID:", user.uid);
        } else {
          console.log("No user found, attempting sign-in...");
          try {
            if (initialAuthToken) {
              await signInWithCustomToken(authInstance, initialAuthToken);
            } else {
              await signInAnonymously(authInstance);
            }
          } catch (authError) {
            console.error("Error during sign-in:", authError);
            setAppError("Authentication failed. Please refresh.");
            setIsLoading(false);
          }
        }
      });

      return () => unsubscribe();
      
    } catch (error) {
      console.error("Firebase initialization error:", error);
      setAppError("Failed to initialize app. Check console.");
      setIsLoading(false);
    }
  }, []);

  // 2. Set up Firestore real-time listener for the file list
  useEffect(() => {
    if (!db || !userId || !sessionId) {
      setFiles([]); // Clear files if no session
      return;
    }

    // Path to the 'files' collection within a specific session
    const filesColPath = `artifacts/${appId}/public/data/quickdrop-sessions/${sessionId}/files`;
    const filesColRef = collection(db, filesColPath);
    const q = query(filesColRef); // You could add orderBy here, but it requires an index

    console.log(`Listening to collection: ${filesColPath}`);

    const unsubscribe = onSnapshot(q, (querySnapshot) => {
      const filesData = [];
      querySnapshot.forEach((doc) => {
        filesData.push({ id: doc.id, ...doc.data() });
      });
      // Sort by timestamp in JS to avoid needing a composite index
      filesData.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
      setFiles(filesData);
      console.log("Received file list from Firestore:", filesData);
    }, (error) => {
      console.error("Error in onSnapshot listener:", error);
      setAppError("Connection error. Please check console.");
    });

    return () => {
      console.log("Cleaning up listener for session:", sessionId);
      unsubscribe();
    };
  }, [db, userId, sessionId, appId]);

  // 3. Handle creating a new session
  const handleCreateSession = () => {
    const newId = generateFriendlyId();
    setSessionId(newId);
  };

  // 4. Handle joining an existing session
  const handleJoinSession = (e) => {
    e.preventDefault();
    if (joinInput.trim()) {
      setSessionId(joinInput.trim().toLowerCase());
    }
  };

  // 5. Handle leaving a session
  const handleLeaveSession = () => {
    setSessionId(null);
    setJoinInput('');
    setAppError(null);
    setUploadingFiles({});
  };

  // 6. Handle file upload (from drop or input)
  const handleFileUpload = useCallback((droppedFiles) => {
    if (!storage || !db || !sessionId || !userId) {
      setAppError("Not connected. Cannot upload files.");
      return;
    }

    // Limit file size (e.g., 100MB as per your proposal)
    const MAX_SIZE = 100 * 1024 * 1024;

    for (const file of droppedFiles) {
      if (file.size > MAX_SIZE) {
        setAppError(`File ${file.name} is too large (Max 100MB).`);
        continue;
      }
      
      const uniqueFileName = `${Date.now()}-${file.name}`;
      // Use a public path for this demo
      const storagePath = `artifacts/${appId}/public/quickdrop-files/${sessionId}/${uniqueFileName}`;
      const storageRef = ref(storage, storagePath);
      
      const uploadTask = uploadBytesResumable(storageRef, file);

      // Update uploading state
      setUploadingFiles(prev => ({ ...prev, [uniqueFileName]: 0 }));

      uploadTask.on('state_changed',
        (snapshot) => {
          // Progress function
          const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
          setUploadingFiles(prev => ({ ...prev, [uniqueFileName]: progress }));
        },
        (error) => {
          // Error function
          console.error("Upload error:", error);
          setAppError(`Failed to upload ${file.name}.`);
          setUploadingFiles(prev => {
            const newState = { ...prev };
            delete newState[uniqueFileName];
            return newState;
          });
        },
        async () => {
          // Complete function
          const downloadURL = await getDownloadURL(uploadTask.snapshot.ref);
          
          // Add file metadata to Firestore
          const filesColPath = `artifacts/${appId}/public/data/quickdrop-sessions/${sessionId}/files`;
          try {
            await addDoc(collection(db, filesColPath), {
              name: file.name,
              size: file.size,
              type: file.type,
              url: downloadURL,
              storagePath: storagePath,
              uploaderId: userId,
              createdAt: serverTimestamp()
            });
          } catch (error) {
            console.error("Error writing file metadata to Firestore:", error);
            setAppError("Upload complete, but failed to save file metadata.");
          }

          // Remove from uploading state
          setUploadingFiles(prev => {
            const newState = { ...prev };
            delete newState[uniqueFileName];
            return newState;
          });
        }
      );
    }
  }, [storage, db, sessionId, userId, appId]);

  // 7. Drag-and-drop event handlers
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
        <div className="text-2xl font-semibold">Initializing QuickDrop...</div>
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
            onClick={() => setAppError(null)} // Clear error
            className="mt-6 px-4 py-2 bg-red-600 hover:bg-red-500 rounded-md font-semibold text-white shadow-lg transition-all"
          >
            Dismiss
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
                onChange={(e) => setJoinInput(e.target.value.toLowerCase())}
                placeholder="Enter session code (e.g. swift-fox-12)"
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
                      <span>{name}</span>
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
              {files.length === 0 && (
                <p className="text-gray-500 text-center py-4">No files shared in this session yet.</p>
              )}
              {files.map(file => (
                <div key={file.id} className="flex items-center justify-between p-4 bg-gray-800 rounded-lg border border-gray-700">
                  <div>
                    <p className="text-lg font-medium text-cyan-300">{file.name}</p>
                    <p className="text-sm text-gray-400">{formatBytes(file.size)} - {file.type}</p>
                  </div>
                  <a
                    href={file.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    download={file.name}
                    className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white font-semibold rounded-lg shadow-md transition-colors text-sm"
                  >
                    Download
                  </a>
                </div>
              ))}
            </div>
          </div>
          
        </div>
      )}
      
      {/* Footer with User ID */}
      <footer className="w-full max-w-5xl mx-auto mt-8 text-center text-gray-500 text-xs">
        <p>Your User ID: <span className="font-mono">{userId || '...'}</span></p>
      </footer>
    </div>
  );
}

