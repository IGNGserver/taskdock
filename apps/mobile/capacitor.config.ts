import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.devtodo.app',
  appName: 'TaskDock',
  webDir: '../web/dist',
  bundledWebRuntime: false,
  server: { androidScheme: 'https', cleartext: false },
  android: { allowMixedContent: false, captureInput: false },
  plugins: { App: { disableBackButtonHandler: true } },
};

export default config;
