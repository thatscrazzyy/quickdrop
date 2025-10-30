// quickdrop-api/index.js

import express from 'express';
import { Firestore } from '@google-cloud/firestore';
import { Storage } from '@google-cloud/storage';
import cors from 'cors';
import { PubSub } from '@google-cloud/pubsub';

// --- Configuration ---
const app = express();
const PORT = process.env.PORT || 8080;
const BUCKET_NAME = 'quickdrop-9a015.firebasestorage.app'; 
const MAX_FILE_SIZE_MB = 100; // Max file size limit is 100 MB
const PUB_SUB_TOPIC_NAME = 'file-ready';
// --- Initialize Admin SDKs ---
// We use a service account key for local testing.
// In Cloud Run, it will *automatically* use the runtime service account.
const firestore = new Firestore({
  keyFilename: './service-account-key.json',
  projectId: 'quickdrop-9a015',
});

const storage = new Storage({
  keyFilename: './service-account-key.json',
  projectId: 'quickdrop-9a015',
});
const bucket = storage.bucket(BUCKET_NAME);

const pubsub = new PubSub({
  keyFilename: './service-account-key.json',
  projectId: 'quickdrop-9a015',
});

// --- Middleware ---
app.use(cors()); // Allow cross-origin requests
app.use(express.json()); // Parse JSON request bodies

// --- Helper Functions ---
/**
 * Generates a 6-digit numeric code. [cite: 31, 43]
 */
const generateSessionCode = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// --- API Endpoints ---

/**
 */
app.post('/api/create-session', async (req, res) => {
  try {
    const sessionId = generateSessionCode();
    const sessionRef = firestore.collection('quickdrop-sessions').doc(sessionId);

    // Store the session in Firestore [cite: 43]
    await sessionRef.set({
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 60 min TTL [cite: 37]
      files: [],
    });

    console.log(`Session created: ${sessionId}`);
    res.status(201).json({ sessionId });
  } catch (error) {
    console.error('Error creating session:', error);
    res.status(500).send({ message: 'Failed to create session' });
  }
});

/**
 * [SPRINT 1] Gets a signed PUT URL for file upload. [cite: 33, 44]
 * Implements uploading logic. 
 */
app.post('/api/get-upload-url', async (req, res) => {
  const { sessionId, fileName, fileType, fileSize } = req.body;

  if (!sessionId || !fileName || !fileType || !fileSize) {
    return res.status(400).send({ message: 'Missing required parameters.' });
  }

  // Enforce file size limit [cite: 43]
  if (fileSize > MAX_FILE_SIZE_MB * 1024 * 1024) {
    return res.status(400).send({ message: `File exceeds ${MAX_FILE_SIZE_MB}MB limit.` });
  }

  // Validate session exists
  const sessionDoc = await firestore.collection('quickdrop-sessions').doc(sessionId).get();
  if (!sessionDoc.exists) {
    return res.status(404).send({ message: 'Session not found.' });
  }
  
  // Use per-session Storage prefix for security [cite: 47]
  const storagePath = `quickdrop-files/${sessionId}/${Date.now()}-${fileName}`;
  const file = bucket.file(storagePath);

  // Configure the signed URL
  const options = {
    version: 'v4',
    action: 'write',
    expires: Date.now() + 15 * 60 * 1000, // 15-minute expiry
    contentType: fileType,
  };

  try {
    const [uploadUrl] = await file.getSignedUrl(options);
    res.status(200).json({ uploadUrl, storagePath });
  } catch (error) {
    console.error('Error generating signed URL:', error);
    res.status(500).send({ message: 'Failed to generate upload URL.' });
  }
});

// 1. Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // 2. Create a unique, temporary Pub/Sub subscription
  // This subscription will be auto-deleted after 10 minutes of inactivity.
  const subscriptionName = `session-sub-${sessionId}-${Date.now()}`;
  const subscriptionOptions = {
    gaxOpts: {
      deadline: 300000, // 5 minutes
    },
    filter: `attributes.sessionId = "${sessionId}"`, // <-- CRITICAL: Only get messages for this session
    messageRetentionDuration: 600, // 10 minutes
    expirationPolicy: {
      ttl: {
        seconds: 600, // 10 minutes
      },
    },
  };

  let subscription;
  try {
    [subscription] = await pubsub
      .topic(PUB_SUB_TOPIC_NAME)
      .createSubscription(subscriptionName, subscriptionOptions);
    console.log(`Created subscription: ${subscriptionName}`);
  } catch (error) {
    console.error(`Failed to create subscription:`, error);
    return res.status(500).end();
  }

  // 3. Define the message handler
  const messageHandler = (message) => {
    console.log(`Received message for ${sessionId}:`, message.data.toString());
    // Send to client in SSE format: "data: {JSON_PAYLOAD}\n\n"
    res.write(`data: ${message.data.toString()}\n\n`);
    message.ack(); // Acknowledge the message
  };

  // 4. Listen for messages
  subscription.on('message', messageHandler);

  // 5. Handle client disconnect
  req.on('close', () => {
    console.log(`Client disconnected from SSE on session: ${sessionId}`);
    subscription.removeListener('message', messageHandler);
    subscription.delete().catch(err => {
      console.error(`Failed to delete subscription ${subscriptionName}:`, err);
    });
    res.end();
  });
// --- Start Server ---
app.listen(PORT, () => {
  console.log(`QuickDrop API server listening on port ${PORT}`);
});