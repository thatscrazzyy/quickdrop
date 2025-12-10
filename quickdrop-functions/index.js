const { Storage } = require("@google-cloud/storage");
const { Firestore } = require("@google-cloud/firestore");
const { PubSub } = require("@google-cloud/pubsub");

const storage = new Storage();
const firestore = new Firestore();
const pubsub = new PubSub();

const BUCKET_NAME = "quickdrop-9a015.firebasestorage.app"; // make sure this matches
const TOPIC_NAME = "file-ready";

exports.updateFileMetadata = async (event) => {
  console.log("=== updateFileMetadata triggered ===");
  console.log("Raw event:", JSON.stringify(event));

  const bucket = event.bucket;
  const name = event.name;
  const size = event.size;
  const contentType = event.contentType;
  const timeCreated = event.timeCreated;

  console.log("Bucket:", bucket);
  console.log("Name:", name);
  console.log("Size:", size, "Type:", contentType);

  // 1) Make sure this is the right bucket
  if (bucket !== BUCKET_NAME) {
    console.log(`Skipping object from bucket ${bucket}, expected ${BUCKET_NAME}`);
    return;
  }

  // 2) Expect paths like quickdrop-files/{sessionId}/{fileName}
  if (!name.startsWith("quickdrop-files/")) {
    console.log("Skipping object not under quickdrop-files/:", name);
    return;
  }

  const parts = name.split("/");
  if (parts.length < 3) {
    console.log("Skipping object with unexpected path structure:", name);
    return;
  }

  const sessionId = parts[1];
  const originalFileName = parts.slice(2).join("/");

  console.log("Derived sessionId:", sessionId);
  console.log("Original file name:", originalFileName);

  // 3) Build file metadata
  const fileMetadata = {
    name: originalFileName,
    storagePath: name,
    size: Number(size),
    type: contentType,
    createdAt: new Date(timeCreated),
  };

  // 4) Write to Firestore subcollection
  const fileDocRef = await firestore
    .collection("quickdrop-sessions")
    .doc(sessionId)
    .collection("files")
    .add(fileMetadata);

  console.log("Wrote Firestore doc:", fileDocRef.path);

  // 5) Publish Pub/Sub message WITH sessionId attribute
  const messageData = {
    sessionId: sessionId,
    ...fileMetadata,
    id: fileDocRef.id,
  };

  await pubsub.topic(TOPIC_NAME).publishMessage({
    json: messageData,
    attributes: {
      sessionId: sessionId, // must match filter in API
    },
  });

  console.log(`Published to ${TOPIC_NAME}:`, messageData);
};
