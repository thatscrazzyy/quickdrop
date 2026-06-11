// quickdrop-api/index.js

import express from 'express';
import { Firestore } from '@google-cloud/firestore';
import { Storage } from '@google-cloud/storage';
import cors from 'cors';
import { PubSub } from '@google-cloud/pubsub';

const app = express();
const PORT = process.env.PORT || 8080;
const BUCKET_NAME = 'quickdrop-9a015.firebasestorage.app';
const MAX_FILE_SIZE_MB = 100;
const PUB_SUB_TOPIC_NAME = 'file-ready';

const firestore = new Firestore();
const storage = new Storage();
const bucket = storage.bucket(BUCKET_NAME);
const pubsub = new PubSub();

app.use(cors());
app.use(express.json());

const generateSessionCode = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

const isSessionExpired = (data) => {
  const exp = data.expiresAt?.toDate ? data.expiresAt.toDate() : new Date(data.expiresAt);
  return new Date() > exp;
};

// --- Endpoints ---

app.post('/api/create-session', async (_req, res) => {
  try {
    const sessionId = generateSessionCode();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await firestore.collection('quickdrop-sessions').doc(sessionId).set({
      createdAt: new Date(),
      expiresAt,
      files: [],
    });
    console.log(`Session created: ${sessionId}`);
    res.status(201).json({ sessionId, expiresAt: expiresAt.toISOString() });
  } catch (err) {
    console.error('Error creating session:', err);
    res.status(500).json({ message: 'Failed to create session.' });
  }
});

app.get('/api/sessions/:sessionId/validate', async (req, res) => {
  const { sessionId } = req.params;
  try {
    const doc = await firestore.collection('quickdrop-sessions').doc(sessionId).get();
    if (!doc.exists) return res.status(404).json({ message: 'Session not found.' });
    const data = doc.data();
    if (isSessionExpired(data)) return res.status(410).json({ message: 'Session has expired.' });
    const expiresAt = data.expiresAt?.toDate
      ? data.expiresAt.toDate().toISOString()
      : data.expiresAt;
    res.json({ sessionId, expiresAt });
  } catch (err) {
    console.error('Error validating session:', err);
    res.status(500).json({ message: 'Failed to validate session.' });
  }
});

app.post('/api/get-upload-url', async (req, res) => {
  const { sessionId, fileName, fileType, fileSize } = req.body;

  if (!sessionId || !fileName || !fileType || !fileSize) {
    return res.status(400).json({ message: 'Missing required parameters.' });
  }
  if (fileSize > MAX_FILE_SIZE_MB * 1024 * 1024) {
    return res.status(400).json({ message: `File exceeds ${MAX_FILE_SIZE_MB}MB limit.` });
  }

  const sessionDoc = await firestore.collection('quickdrop-sessions').doc(sessionId).get();
  if (!sessionDoc.exists) return res.status(404).json({ message: 'Session not found.' });
  if (isSessionExpired(sessionDoc.data())) return res.status(410).json({ message: 'Session has expired.' });

  const storagePath = `quickdrop-files/${sessionId}/${Date.now()}-${fileName}`;
  const file = bucket.file(storagePath);
  const options = {
    version: 'v4',
    action: 'write',
    expires: Date.now() + 15 * 60 * 1000,
    contentType: fileType,
  };

  try {
    const [uploadUrl] = await file.getSignedUrl(options);
    res.status(200).json({ uploadUrl, storagePath });
  } catch (err) {
    console.error('Error generating signed URL:', err);
    res.status(500).json({ message: 'Failed to generate upload URL.' });
  }
});

app.get('/api/get-download-url', async (req, res) => {
  try {
    const { storagePath } = req.query;
    if (!storagePath) {
      return res.status(400).json({ message: 'Missing storagePath.' });
    }
    const file = bucket.file(storagePath.toString());
    const [exists] = await file.exists();
    if (!exists) return res.status(404).json({ message: 'File not found.' });

    const [downloadUrl] = await file.getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + 15 * 60 * 1000,
    });
    res.json({ downloadUrl });
  } catch (err) {
    console.error('Error generating download URL:', err);
    res.status(500).json({ message: 'Failed to generate download URL.' });
  }
});

app.get('/api/sessions/:sessionId/subscribe', async (req, res) => {
  const { sessionId } = req.params;
  console.log(`SSE connect: ${sessionId}`);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const subscriptionName = `session-sub-${sessionId}-${Date.now()}`;
  const subscriptionOptions = {
    filter: `attributes.sessionId = "${sessionId}"`,
    messageRetentionDuration: 600,
    expirationPolicy: { ttl: { seconds: 600 } },
  };

  let subscription;
  try {
    [subscription] = await pubsub
      .topic(PUB_SUB_TOPIC_NAME)
      .createSubscription(subscriptionName, subscriptionOptions);
  } catch (err) {
    console.error('Failed to create subscription:', err);
    return res.status(500).end();
  }

  const messageHandler = (message) => {
    res.write(`data: ${message.data.toString()}\n\n`);
    message.ack();
  };

  subscription.on('message', messageHandler);

  req.on('close', () => {
    subscription.removeListener('message', messageHandler);
    subscription.delete().catch((err) =>
      console.error(`Failed to delete subscription ${subscriptionName}:`, err)
    );
    res.end();
  });
});

app.get('/api/sessions/:sessionId/files', async (req, res) => {
  const { sessionId } = req.params;
  try {
    const sessionRef = firestore.collection('quickdrop-sessions').doc(sessionId);
    const sessionSnap = await sessionRef.get();
    if (!sessionSnap.exists) return res.status(404).json({ message: 'Session not found.' });

    const filesSnap = await sessionRef.collection('files').orderBy('createdAt', 'desc').get();
    const files = filesSnap.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        ...data,
        createdAt: data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : data.createdAt,
      };
    });
    res.json({ files });
  } catch (err) {
    console.error('Error fetching session files:', err);
    res.status(500).json({ message: 'Failed to load session files.' });
  }
});

// End session: delete all GCS files, Firestore subcollection, and session doc
app.delete('/api/sessions/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  try {
    const sessionRef = firestore.collection('quickdrop-sessions').doc(sessionId);
    const sessionSnap = await sessionRef.get();
    if (!sessionSnap.exists) return res.status(404).json({ message: 'Session not found.' });

    // Delete all GCS objects under this session
    const [gcsFiles] = await bucket.getFiles({ prefix: `quickdrop-files/${sessionId}/` });
    await Promise.all(gcsFiles.map((f) => f.delete().catch(() => null)));

    // Delete Firestore files subcollection
    const filesSnap = await sessionRef.collection('files').get();
    const batch = firestore.batch();
    filesSnap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();

    // Delete session doc
    await sessionRef.delete();

    res.json({ message: 'Session ended and all files deleted.' });
  } catch (err) {
    console.error('Error ending session:', err);
    res.status(500).json({ message: 'Failed to end session.' });
  }
});

// Delete a single file from a session
app.delete('/api/sessions/:sessionId/files/:fileId', async (req, res) => {
  const { sessionId, fileId } = req.params;
  try {
    const fileRef = firestore
      .collection('quickdrop-sessions')
      .doc(sessionId)
      .collection('files')
      .doc(fileId);
    const fileSnap = await fileRef.get();
    if (!fileSnap.exists) return res.status(404).json({ message: 'File not found.' });

    const { storagePath } = fileSnap.data();
    await bucket.file(storagePath).delete().catch(() => null);
    await fileRef.delete();

    res.json({ message: 'File deleted.' });
  } catch (err) {
    console.error('Error deleting file:', err);
    res.status(500).json({ message: 'Failed to delete file.' });
  }
});

app.listen(PORT, () => {
  console.log(`QuickDrop API listening on port ${PORT}`);
});
