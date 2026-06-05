export interface ClassSession {
  id: string;
  dayOfWeek: string;
  startTime: string; // HH:MM
  endTime: string;   // HH:MM
  subjectCode: string;
  subjectName: string;
  room: string;
  teacher: string;
}

export interface AppSettings {
  notifyTeacher: boolean;
  notifySubjectCode: boolean;
  notifySubjectName: boolean;
  notifyRoom: boolean;
  notifyEnd: boolean;
  notificationSound?: string; // Base64 storage
  popupDuration: number; // in seconds
  preNotifyMinutes?: number; // Minutes before class starts (default: 3)
  calendarHolidays?: Record<string, string>; // YYYY-MM-DD -> Holiday Name
}

export interface ActiveNotification {
  title: string;
  body: string;
  type: 'start' | 'end';
}

export const DEFAULT_SUBJECT_MAPPINGS: Record<string, string> = {
  'ว30103': 'วิทยาการคำนวณ',
  'ว30266': 'ดาราศาสตร์',
  'ท31101': 'ภาษาไทย',
  'อ30201': 'ภาษาอังกฤษ',
  'ก31901': 'แนะแนว',
  'ค31101': 'คณิตศาสตร์พื้นฐาน',
  'อ31101': 'ภาษาอังกฤษ',
  'ส31101': 'สังคมศึกษา',
  'ว31221': 'เคมี',
  'พ31101': 'สุขศึกษา',
  'ค31201': 'คณิตศาสตร์เพิ่มเติม',
  'ว31201': 'ฟิสิกส์',
  'ศ31101': 'ดนตรี/ศิลปะ',
  'ว31241': 'ชีววิทยา',
  'ส31103': 'ประวัติศาสตร์',
  'ง31101': 'การงานอาชีพ'
};

