import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.schedule.notifier.thai',
  appName: 'แจ้งเตือนตารางเรียน',
  webDir: 'www',
  server: {
    allowNavigation: [
      'github.com',
      '*.github.com',
      '*.githubusercontent.com',
      '*.google.com',
      '*.googleapis.com'
    ]
  },
  plugins: {
    CapacitorHttp: {
      enabled: true
    },
    CapacitorUpdater: {
      autoUpdate: false,
      statsUrl: ''
    }
  }
};

export default config;
