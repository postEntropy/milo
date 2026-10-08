import type { SVGProps } from 'react'

const paths: Record<string, React.ReactNode> = {
  plus: <><path d="M12 5v14M5 12h14" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  send: <><path d="M21.5 2.5 11 13" /><path d="M21.5 2.5 15 21.5l-4-8.5-8.5-4Z" /></>,
  stop: <><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" /></>,
  chevron: <><path d="m9 6 6 6-6 6" /></>,
  'arrow-left': <><path d="M19 12H5" /><path d="m11 18-6-6 6-6" /></>,
  'arrow-down': <><path d="M12 5v14" /><path d="m5 12 7 7 7-7" /></>,
  'panel-left': <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
  'panel-right': <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></>,
  code: <><path d="m9 8-5 4 5 4" /><path d="m15 8 5 4-5 4" /></>,
  quote: <><path d="M8 7H5a1 1 0 0 0-1 1v3a1 1 0 0 0 1 1h3v1.5A2.5 2.5 0 0 1 5.5 16" /><path d="M18 7h-3a1 1 0 0 0-1 1v3a1 1 0 0 0 1 1h3v1.5A2.5 2.5 0 0 1 15.5 16" /></>,
  check: <><path d="m5 13 4 4L19 7" /></>,
  circle: <><circle cx="12" cy="12" r="9" /></>,
  'circle-dot': <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" /></>,
  'list-check': <><path d="m4 6 1.5 1.5L8 5" /><path d="M11 6h9M11 12h9M11 18h9" /><path d="m4 12 1.5 1.5L8 11m-4 7 1.5 1.5L8 17" /></>,
  x: <><path d="m6 6 12 12M18 6 6 18" /></>,
  shield: <><path d="m12 3 7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" /></>,
  key: <><circle cx="8" cy="15" r="4" /><path d="m11.5 12.5 8.5-8.5M17 4h3v3" /></>,
  light: <><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.4 1 1 1 1.6h5c0-.6.4-1.2 1-1.6A6 6 0 0 0 12 3Z" /></>,
  database: <><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>,
  server: <><rect x="3" y="4" width="18" height="6" rx="2" /><rect x="3" y="14" width="18" height="6" rx="2" /><path d="M7 7h.01M7 17h.01" /></>,
  settings: <><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></>,
  lock: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
  eye: <><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" /><circle cx="12" cy="12" r="2.5" /></>,
  audio: <><path d="M3 10v4m4-7v10m4-14v18m4-15v12m4-9v6m3-4v2" /></>,
  spark: <><path d="m12 3 1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6Z" /><path d="m19 15 .7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7Z" /></>,
  history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 4v4h4m5 0v4l3 2" /></>,
  menu: <><path d="M4 7h16M4 12h16M4 17h16" /></>,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>,
  file: <><path d="M6 3h8l4 4v14H6zM14 3v4h4" /></>,
  terminal: <><rect x="4" y="5" width="16" height="14" rx="2" /><path d="m8 10 2.5 2.5L8 15m5 0h3" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  cpu: <><rect x="7" y="7" width="10" height="10" rx="2" /><path d="M10 2v3m4-3v3M10 19v3m4-3v3M2 10h3m-3 4h3m14-4h3m-3 4h3" /></>,
  download: <><path d="M12 3v12m0 0 4-4m-4 4-4-4" /><path d="M4 19h16" /></>,
  trash: <><path d="M4 7h16M10 4h4M9 7v12m6-12v12M6 7l1 13h10l1-13" /></>,
  note: <><path d="M5 3h9l5 5v13H5zM14 3v5h5" /><path d="M9 13h6M9 17h4" /></>,
  play: <><path d="M7 4.5v15l13-7.5Z" /></>,
  pause: <><rect x="7" y="5" width="3.5" height="14" rx="1" /><rect x="13.5" y="5" width="3.5" height="14" rx="1" /></>,
  folder: <><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></>,
  'file-plus': <><path d="M6 3h8l4 4v14H6zM14 3v4h4" /><path d="M12 12v5M9.5 14.5h5" /></>,
  files: <><path d="M9 3h6l4 4v12H9zM15 3v4h4" /><path d="M5 7v14h9" /></>,
  link: <><path d="M10 13a4 4 0 0 0 5.6 0l3-3a4 4 0 0 0-5.6-5.6l-1.5 1.5" /><path d="M14 11a4 4 0 0 0-5.6 0l-3 3a4 4 0 0 0 5.6 5.6l1.5-1.5" /></>,
  camera: <><path d="M4 8h3l1.5-2h7L17 8h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></>,
  cursor: <><path d="M5.5 3.5 19 10.5l-6 1.8-1.8 6z" /></>,
  compass: <><circle cx="12" cy="12" r="9" /><path d="m15.5 8.5-2 5-5 2 2-5z" /></>,
  repeat: <><path d="M4 11V9a4 4 0 0 1 4-4h9m0 0-3-3m3 3-3 3" /><path d="M20 13v2a4 4 0 0 1-4 4H7m0 0 3 3m-3-3 3-3" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.4 2.6 2.4 15.4 0 18M12 3c-2.4 2.6-2.4 15.4 0 18" /></>,
  dots: <><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" /><circle cx="6" cy="12" r="1.5" fill="currentColor" stroke="none" /><circle cx="18" cy="12" r="1.5" fill="currentColor" stroke="none" /></>,
  edit: <><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></>,
  branch: <><line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7.5 9 6 9-6" /></>,
  // The mail mark every email tool wears: one envelope-with-shield rather than
  // per-action art, so the four tools read the same on the line.
  'mail-shield': <path d="M11 19H6.2C5.0799 19 4.51984 19 4.09202 18.782C3.71569 18.5903 3.40973 18.2843 3.21799 17.908C3 17.4802 3 16.9201 3 15.8V8.2C3 7.0799 3 6.51984 3.21799 6.09202C3.40973 5.71569 3.71569 5.40973 4.09202 5.21799C4.51984 5 5.0799 5 6.2 5H17.8C18.9201 5 19.4802 5 19.908 5.21799C20.2843 5.40973 20.5903 5.71569 20.782 6.09202C21 6.51984 21 7.0799 21 8.2V11.1981M20.6067 8.26229L15.5499 11.6335C14.2669 12.4888 13.6254 12.9165 12.932 13.0827C12.3192 13.2295 11.6804 13.2295 11.0677 13.0827C10.3743 12.9165 9.73279 12.4888 8.44975 11.6335L3.14746 8.09863M21 15.1667C21 15.1667 20.6941 15.1667 20.625 15.1667C19.6006 15.1667 18.7077 14.7524 18 14C17.2923 14.7524 16.3995 15.1667 15.375 15.1667C15.306 15.1667 15 15.1667 15 15.1667C15 15.1667 15 15.9444 15 16.3979C15 18.6121 16.2748 20.4725 18 21C19.7252 20.4725 21 18.6121 21 16.3979C21 15.9444 21 15.1667 21 15.1667Z" />,
  inbox: <><path d="M3 12h5l1.5 2h5L16 12h5" /><path d="M5.5 5h13l2.5 7v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z" /></>,
  archive: <><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" /><path d="M10 12h4" /></>,
  reply: <><path d="m10 8-5 4 5 4" /><path d="M5 12h9a5 5 0 0 1 5 5v1" /></>,
  refresh: <><path d="M20 11a8 8 0 1 0-.6 4" /><path d="M20 5v6h-6" /></>,
  // The Model Context Protocol mark: what a tool running on someone else's server
  // wears. Line art on a 180 grid, scaled onto the 24 this set is drawn on, with
  // the stroke widened back so it keeps the set's own weight.
  mcp: <g transform="scale(0.1333333)" strokeWidth={13.5}>
    <path d="M18 84.8528L85.8822 16.9706C95.2548 7.59798 110.451 7.59798 119.823 16.9706V16.9706C129.196 26.3431 129.196 41.5391 119.823 50.9117L68.5581 102.177" />
    <path d="M69.2652 101.47L119.823 50.9117C129.196 41.5391 144.392 41.5391 153.765 50.9117L154.118 51.2652C163.491 60.6378 163.491 75.8338 154.118 85.2063L92.7248 146.6C89.6006 149.724 89.6006 154.789 92.7248 157.913L105.331 170.52" />
    <path d="M102.853 33.9411L52.6482 84.1457C43.2756 93.5183 43.2756 108.714 52.6482 118.087V118.087C62.0208 127.459 77.2167 127.459 86.5893 118.087L136.794 67.8822" />
  </g>,
  drive: <g stroke="none" transform="translate(0 0.84375) scale(0.09375)">
    <defs>
      <linearGradient id="milo-drive-yellow" x1="86.924%" x2="7.63%" y1="94.294%" y2="45.952%">
        <stop offset="9%" stopColor="#ffe921" /><stop offset="100%" stopColor="#fec700" />
      </linearGradient>
      <linearGradient id="milo-drive-blue" x1="99.538%" x2="23.437%" y1="93.901%" y2="54.033%">
        <stop offset="15%" stopColor="#a9a8ff" /><stop offset="33%" stopColor="#6d97ff" /><stop offset="48%" stopColor="#3186ff" />
      </linearGradient>
      <linearGradient id="milo-drive-green" x1="87.128%" x2="-.639%" y1="51.518%" y2="93.078%">
        <stop offset="55%" stopColor="#0ebc5f" /><stop offset="85%" stopColor="#78c9ff" />
      </linearGradient>
      <path id="milo-drive-form" d="M77.303 29.27c22.531-39.026 78.863-39.027 101.394 0l69.373 120.158c22.531 39.027-5.633 87.81-50.698 87.81H58.628c-45.065 0-73.23-48.783-50.698-87.81z" />
      <mask id="milo-drive-cut" fill="#fff"><use href="#milo-drive-form" /></mask>
    </defs>
    <g mask="url(#milo-drive-cut)">
      <path fill="url(#milo-drive-yellow)" d="M341.719 295.937H200.166l-29.293-50.735l70.777-122.589z" transform="translate(-42.87 -58.67)" />
      <path fill="url(#milo-drive-blue)" d="m0 295.916l100.069-173.325v.003l-29.282 50.723h58.57l70.783 122.596l-200.138.001z" transform="translate(-42.87 -58.67)" />
      <path fill="url(#milo-drive-green)" d="m170.881 0l70.781 122.6l-29.286 50.726H70.812z" transform="translate(-42.87 -58.67)" />
    </g>
  </g>,
}

export type IconName = keyof typeof paths

export function Icon({ name, size = 18, className = '', ...props }: SVGProps<SVGSVGElement> & { name: IconName; size?: number }) {
  return <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>
}
