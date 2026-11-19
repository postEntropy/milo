import { useId } from 'react'
import {
  CREW_AVATAR_ACCESSORIES,
  CREW_AVATAR_EYES,
  CREW_AVATAR_SHAPES,
  defaultBotAvatar,
  type CrewAvatar,
  type CrewAvatarAccessory,
  type CrewAvatarEyes,
  type CrewAvatarShape,
} from '../../../src/core/crew-avatars.js'
import type { CrewBot } from '../../../src/core/crew.js'
import { COLOR_PALETTES, colorPalettePreset } from '../theme/palettes.js'

export {
  COLOR_PALETTES,
  CREW_AVATAR_ACCESSORIES,
  CREW_AVATAR_EYES,
  CREW_AVATAR_SHAPES,
  type CrewAvatar,
  type CrewAvatarAccessory,
  type CrewAvatarEyes,
  type CrewAvatarShape,
}

export const SHAPE_LABELS: Record<CrewAvatarShape, string> = {
  orb: 'Orb',
  pebble: 'Pebble',
  capsule: 'Capsule',
  droplet: 'Droplet',
  puff: 'Puff',
  gem: 'Gem',
  dome: 'Dome',
  star: 'Star',
}

export const EYES_LABELS: Record<CrewAvatarEyes, string> = {
  capsule: 'Capsule',
  happy: 'Happy',
  curious: 'Curious',
  visor: 'Visor',
  wink: 'Wink',
  spark: 'Spark',
}

export const ACCESSORY_LABELS: Record<CrewAvatarAccessory, string> = {
  none: 'None',
  antenna: 'Antenna',
  sprout: 'Sprout',
  glasses: 'Glasses',
  headphones: 'Headphones',
  crown: 'Crown',
}

export function botAvatarOf(bot: Pick<CrewBot, 'id' | 'name' | 'avatar'>): CrewAvatar {
  return bot.avatar ?? defaultBotAvatar(bot.id, bot.name)
}

export function botToneOf(avatar: CrewAvatar): string {
  return colorPalettePreset(avatar.palette).logoColors[0]
}

function renderBody(shape: CrewAvatarShape, fill: string) {
  switch (shape) {
    case 'orb':
      return <circle cx="20" cy="21" r="13.5" fill={fill} />
    case 'pebble':
      return <rect x="6.5" y="7.5" width="27" height="27" rx="9.5" fill={fill} />
    case 'capsule':
      return <rect x="8.5" y="6" width="23" height="29" rx="11.5" fill={fill} />
    case 'droplet':
      return <path d="M20 5.5C27.5 12.6 33.5 17.4 33.5 23.8A13.5 11.7 0 1 1 6.5 23.8C6.5 17.4 12.5 12.6 20 5.5Z" fill={fill} />
    case 'puff':
      return (
        <path
          d="M20 6.5C23.8 6.5 26.8 8.3 27.8 11.2C31.6 12.2 33.8 15.2 33.8 19.8C33.8 23.8 31.8 26.8 28.8 28.6C26.8 32.4 23.8 34.5 20 34.5C16.2 34.5 13.2 32.4 11.2 28.6C8.2 26.8 6.2 23.8 6.2 19.8C6.2 15.2 8.4 12.2 12.2 11.2C13.2 8.3 16.2 6.5 20 6.5Z"
          fill={fill}
        />
      )
    case 'gem':
      return <path d="M14.2 7H25.8L33 14.2V26.8L25.8 34H14.2L7 26.8V14.2Z" fill={fill} stroke={fill} strokeWidth="2.5" strokeLinejoin="round" />
    case 'dome':
      return <path d="M7 22.5C7 13.2 12.4 7.5 20 7.5C27.6 7.5 33 13.2 33 22.5V29.5C33 32 31 34 28.5 34H11.5C9 34 7 32 7 29.5Z" fill={fill} />
    case 'star':
      return (
        <path
          d="M20 6.5C22.8 12.8 27.2 17.2 33.5 20.5C27.2 23.8 22.8 28.2 20 34.5C17.2 28.2 12.8 23.8 6.5 20.5C12.8 17.2 17.2 12.8 20 6.5Z"
          fill={fill}
          stroke={fill}
          strokeWidth="3.5"
          strokeLinejoin="round"
        />
      )
  }
}

function renderEyes(eyes: CrewAvatarEyes) {
  switch (eyes) {
    case 'capsule':
      return (
        <g className="bot-avatar-eyes">
          <rect x="13.4" y="16.4" width="3.6" height="8.2" rx="1.8" fill="#FFFFFF" />
          <rect x="23" y="16.4" width="3.6" height="8.2" rx="1.8" fill="#FFFFFF" />
        </g>
      )
    case 'happy':
      return (
        <g className="bot-avatar-eyes" fill="none" stroke="#FFFFFF" strokeWidth="2.5" strokeLinecap="round">
          <path d="M12.2 21.8Q15.1 16.6 18 21.8" />
          <path d="M22 21.8Q24.9 16.6 27.8 21.8" />
        </g>
      )
    case 'curious':
      return (
        <g className="bot-avatar-eyes">
          <circle cx="15" cy="21" r="2.8" fill="#FFFFFF" />
          <circle cx="24.8" cy="19.6" r="2" fill="#FFFFFF" />
          <path d="M22.3 15.8Q24.8 14.3 27.3 15.8" fill="none" stroke="#FFFFFF" strokeWidth="1.7" strokeLinecap="round" />
        </g>
      )
    case 'visor':
      return (
        <g className="bot-avatar-eyes">
          <rect x="9.8" y="16.4" width="20.4" height="7.6" rx="3.8" fill="rgba(15, 17, 23, 0.68)" />
          <rect x="13.2" y="18.9" width="4.4" height="2.6" rx="1.3" fill="#FFFFFF" />
          <rect x="22.4" y="18.9" width="4.4" height="2.6" rx="1.3" fill="#FFFFFF" />
        </g>
      )
    case 'wink':
      return (
        <g className="bot-avatar-eyes">
          <path d="M12.5 18.4L16.7 20.6L12.5 22.8" fill="none" stroke="#FFFFFF" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="22.8" y="16.4" width="3.6" height="8.2" rx="1.8" fill="#FFFFFF" />
        </g>
      )
    case 'spark':
      return (
        <g className="bot-avatar-eyes" fill="#FFFFFF">
          <path d="M15.2 15.8L16.3 19.1L19.6 20.2L16.3 21.3L15.2 24.6L14.1 21.3L10.8 20.2L14.1 19.1Z" />
          <path d="M24.8 15.8L25.9 19.1L29.2 20.2L25.9 21.3L24.8 24.6L23.7 21.3L20.4 20.2L23.7 19.1Z" />
        </g>
      )
  }
}

function renderAccessory(accessory: CrewAvatarAccessory, primary: string, secondary: string) {
  switch (accessory) {
    case 'none':
      return null
    case 'antenna':
      return (
        <g>
          <path d="M20 7.5V4" stroke={primary} strokeWidth="2.2" strokeLinecap="round" />
          <circle cx="20" cy="3.7" r="2" fill={secondary} />
        </g>
      )
    case 'sprout':
      return (
        <g>
          <path d="M20 8V4.2" stroke="#3D9B83" strokeWidth="2" strokeLinecap="round" />
          <path d="M20 5.2C16.5 2.2 13.5 3.6 15 6.6C16.5 8.1 19 6.6 20 5.2Z" fill="#73A66A" />
          <path d="M20 5.2C23.5 2.2 26.5 3.6 25 6.6C23.5 8.1 21 6.6 20 5.2Z" fill="#83CBB0" />
        </g>
      )
    case 'glasses':
      return (
        <g stroke="rgba(255, 255, 255, 0.92)" strokeWidth="1.5">
          <rect x="10" y="15.8" width="9.2" height="9.2" rx="3.4" fill="rgba(15, 17, 23, 0.14)" />
          <rect x="20.8" y="15.8" width="9.2" height="9.2" rx="3.4" fill="rgba(15, 17, 23, 0.14)" />
          <path d="M19.2 19.8H20.8" fill="none" strokeLinecap="round" />
        </g>
      )
    case 'headphones':
      return (
        <g>
          <path d="M7.5 20A12.5 12.5 0 0 1 32.5 20" fill="none" stroke={primary} strokeWidth="2.4" strokeLinecap="round" />
          <rect x="4" y="16.8" width="3.8" height="8.6" rx="1.9" fill={primary} />
          <rect x="32.2" y="16.8" width="3.8" height="8.6" rx="1.9" fill={primary} />
        </g>
      )
    case 'crown':
      return (
        <path
          d="M13.8 8.4L15.2 3.2L20 6.4L24.8 3.2L26.2 8.4Z"
          fill="#E9AF56"
          stroke="#D96B36"
          strokeWidth="1"
          strokeLinejoin="round"
        />
      )
  }
}

export function BotAvatar({
  avatar,
  state,
  size = 36,
  animated = false,
  className = '',
}: {
  avatar: CrewAvatar
  state?: string
  size?: number
  animated?: boolean
  className?: string
}) {
  const uid = useId().replace(/:/g, '')
  const gradId = `bot-avatar-grad-${uid}`
  const shineId = `bot-avatar-shine-${uid}`
  const clipId = `bot-avatar-clip-${uid}`
  const preset = colorPalettePreset(avatar.palette)
  const [topColor, bottomColor] = preset.logoColors
  const running = state === 'running'
  const liveDot = Math.max(7, Math.round(size * 0.22))

  return (
    <span
      className={`bot-avatar ${running ? 'bot-avatar-running' : animated ? 'bot-avatar-idle' : ''} ${className}`.trim()}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg width={size} height={size} viewBox="2.5 1.5 35 35" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id={gradId} x1="8" y1="6" x2="32" y2="35" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor={topColor} />
            <stop offset="100%" stopColor={bottomColor} />
          </linearGradient>
          <linearGradient id={shineId} x1="20" y1="7" x2="20" y2="22" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
          </linearGradient>
          <clipPath id={clipId}>
            {renderBody(avatar.shape, '#000000')}
          </clipPath>
        </defs>
        <g className="bot-avatar-figure">
          {renderBody(avatar.shape, `url(#${gradId})`)}
          <ellipse cx="17.5" cy="12.5" rx="6.5" ry="3.2" fill={`url(#${shineId})`} clipPath={`url(#${clipId})`} />
          {renderEyes(avatar.eyes)}
          {renderAccessory(avatar.accessory, topColor, bottomColor)}
        </g>
      </svg>
      {running && <span className="bot-avatar-live" style={{ width: liveDot, height: liveDot }} />}
    </span>
  )
}
