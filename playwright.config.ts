import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
const localChrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export default defineConfig({
  testDir:'./tests/browser',fullyParallel:false,workers:1,timeout:30000,
  reporter:'list',use:{baseURL:'http://127.0.0.1:4188',viewport:{width:1440,height:1000},screenshot:'only-on-failure',
    launchOptions:existsSync(localChrome)?{executablePath:localChrome}:{}},
  webServer:{command:'node server/dist/index.js',url:'http://127.0.0.1:4188',reuseExistingServer:false,timeout:30000,
    env:{PASSKEY_ENABLED:'true',LINE_MFA_ENABLED:'false',FIREBASE_PHONE_ENABLED:'false',FIREBASE_PHONE_REQUIRED:'false',DB_SOCKET_PATH:'',NODE_ENV:'development',PORT:'4188',APP_ORIGIN:'http://127.0.0.1:4188',GOOGLE_CLIENT_ID:'',GOOGLE_CLIENT_SECRET:'',DB_USER:'',DB_PASSWORD:'',MAIL_MODE:'disabled',MFA_EVIDENCE_KEY:'',MFA_EVIDENCE_DIR:'/private/tmp/cusa-browser-unused'}},
});
