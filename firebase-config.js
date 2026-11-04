// Firebase Console > Project settings > Your apps から設定値を貼り付けてください。
// apiKey等はブラウザに公開される値ですが、Realtime Database RulesとCallable Functionsで必ず保護してください。
export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  databaseURL: "https://YOUR_PROJECT_ID-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "YOUR_PROJECT_ID",
  appId: "YOUR_APP_ID"
};