import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.schedule.notifier.thai',
  appName: 'แจ้งเตือนตารางเรียน',
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
    CapacitorUpdater: {
      autoUpdate: false,
      statsUrl: ''
    }
  }
};

export default config;
