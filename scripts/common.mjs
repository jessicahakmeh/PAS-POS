// Shared Firestore setup for the Node scripts (same project config as app.js).
import { initializeApp } from 'firebase/app';
import * as fs from 'firebase/firestore';
import { createCore } from '../core.js';

const app = initializeApp({ apiKey: 'AIzaSyBKzu5iUwWngth6OX1h4KA5Vqe9UdaI8zA', authDomain: 'pos-pas.firebaseapp.com', projectId: 'pos-pas' });
export const db = fs.getFirestore(app);
export { fs };
export const core = createCore(db, fs);
