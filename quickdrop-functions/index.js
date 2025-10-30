// quickdrop-functions/index.js
// --- CONVERTED TO COMMONJS SYNTAX ---

const { getFirestore } = require('firebase-admin/firestore');
const { PubSub } = require('@google-cloud/pubsub');
const { initializeApp, getApps } = require('firebase-admin/app');

// Initialize Admin SDK
if (getApps().length === 0) {
  initializeApp();
}

const db = getFirestore();
const pubsub = new PubSub();
const TOPIC_NAME = 'file-ready'; // The topic you created

/**
 * Eventarc trigger for new files in Cloud Storage.
 * Triggered by 'google.cloud.storage.object.v1.finalized'
 */
// --- USE EXPORTS.FUNCTION_NAME ---
exports.updateFileMetadata = async (event) => {
  console.log('File event received:', JSON.stringify(event));

  const file = event.data;
  if (!file || !file.name) {
    console.warn('No file data in event.');
    return;
  }

  const { name, bucket, size, contentType, timeCreated } = file;

  // 1. Extract info from the file path
  // Path is "quickdrop-files/{sessionId}/{fileName}"
  const pathParts = name.split('/');
  if (pathParts[0] !== 'quickdrop-files' || pathParts.length < 3) {
    console.warn(`File path ${name} is not a quickdrop file. Skipping.`);
    return;
  }
  
  const sessionId = pathParts[1];
  const originalFileName = pathParts.slice(2).join('/'); // In case filename had '/'

  // 2. Create the metadata object
  const fileMetadata = {
    name: originalFileName,
    storagePath: name,
    size: Number(size),
    type: contentType,
    createdAt: new Date(timeCreated),
  };
  
  console.log(`Writing metadata for session ${sessionId}:`, fileMetadata);

  try {
    // 3. Write metadata to Firestore
    const filesCol = db.collection(`quickdrop-sessions/${sessionId}/files`);
    const fileDocRef = await filesCol.add(fileMetadata);
    console.log(`Wrote to Firestore, doc ID: ${fileDocRef.id}`);

    // 4. Publish "file-ready" event to Pub/Sub
    const messageData = {
      sessionId: sessionId,
      ...fileMetadata, // Send the full file object
      id: fileDocRef.id, // Include the new Firestore document ID
    };
    
    await pubsub.topic(TOPIC_NAME).publishMessage({
      json: messageData,
    });
    console.log(`Published to ${TOPIC_NAME}:`, messageData);

  } catch (error) {
    console.error('Failed to process file event:', error);
  }
};