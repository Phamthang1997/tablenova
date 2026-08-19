import React from 'react';
import type { AiProviderType } from '../../utils/aiConfig';

interface AiIconProps {
  provider?: AiProviderType;
  size?: number;
  className?: string;
}

export const AiProviderIcon: React.FC<AiIconProps> = ({ provider = 'openai', size = 14, className = 'ai-provider-icon' }) => {
  switch (provider) {
    case 'openai':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
          <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8z" />
          <path d="M12 6a6 6 0 1 0 6 6 6 6 0 0 0-6-6zm0 10a4 4 0 1 1 4-4 4 4 0 0 1-4 4z" />
        </svg>
      );
    case 'deepseek':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
          <circle cx="12" cy="12" r="10" />
          <path d="m4.93 4.93 4.24 4.24" />
          <path d="m14.83 9.17 4.24-4.24" />
          <path d="m14.83 14.83 4.24 4.24" />
          <path d="m9.17 14.83-4.24 4.24" />
          <circle cx="12" cy="12" r="4" />
        </svg>
      );
    case 'gemini':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
          <path d="M12 24C12 17.3726 6.62742 12 0 12C6.62742 12 12 6.62742 12 0C12 6.62742 17.3726 12 24 12C17.3726 12 12 17.3726 12 24Z" />
        </svg>
      );
    case 'claude':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
          <path d="M13.5 2C13.5 2 8 8 8 13.5C8 16.5 10.5 19 13.5 19C16.5 19 19 16.5 19 13.5C19 8 13.5 2 13.5 2Z" opacity="0.4"/>
          <path d="M10.5 5C10.5 5 5 11 5 16.5C5 19.5 7.5 22 10.5 22C13.5 22 16 19.5 16 16.5C16 11 10.5 5 10.5 5Z"/>
        </svg>
      );
    case 'ollama':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
          <rect x="4" y="4" width="16" height="16" rx="4" />
          <circle cx="9" cy="9" r="2" />
          <circle cx="15" cy="9" r="2" />
          <path d="M8 15h8" />
        </svg>
      );
    case 'custom':
    default:
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
          <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
        </svg>
      );
  }
};
