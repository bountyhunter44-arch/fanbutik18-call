const firebaseConfig = {
  apiKey: "AIzaSyAGp8sYISVZ_UpbVHQNcQpclp9gltlVtaQ",
  authDomain: "lexivoice-27fc1.firebaseapp.com",
  projectId: "lexivoice-27fc1",
  storageBucket: "lexivoice-27fc1.firebasestorage.app",
  messagingSenderId: "264270037479",
  appId: "1:264270037479:web:40a7442ac96772af217d42",
  measurementId: "G-K7PSSS908X"
};

const app = firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

window.firebaseApp = app;
window.firebaseDb = db;