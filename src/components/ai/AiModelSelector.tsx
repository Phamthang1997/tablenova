import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, Settings } from 'lucide-react';
import { AiProviderIcon } from './AiIcons';
import type { AiAssistantProfile } from '../../utils/aiConfig';

interface AiModelSelectorProps {
  activeProfile: AiAssistantProfile;
  profiles: AiAssistantProfile[];
  onSelectProfile: (profile: AiAssistantProfile) => void;
  onOpenSettings: () => void;
}

export const AiModelSelector: React.FC<AiModelSelectorProps> = ({
  activeProfile,
  profiles,
  onSelectProfile,
  onOpenSettings,
}) => {
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [open]);

  return (
    <div className="ai-model-selector-wrapper" ref={dropdownRef}>
      <button
        className="ai-model-selector-btn"
        onClick={() => setOpen((prev) => !prev)}
        type="button"
      >
        <div className="ai-model-icon-box">
          <AiProviderIcon provider={activeProfile.provider} size={13} />
        </div>
        <span className="ai-model-active-name">{activeProfile.name}</span>
        <span className="ai-model-active-tag">({activeProfile.model})</span>
        <ChevronDown size={12} className="ai-model-chevron" />
      </button>

      {open && (
        <div className="ai-model-dropdown-menu">
          <div className="ai-model-dropdown-header">Chọn Trợ lý / Model</div>
          <div className="ai-model-dropdown-list">
            {profiles.map((profile) => {
              const isSelected = profile.id === activeProfile.id;
              return (
                <button
                  key={profile.id}
                  className={`ai-model-dropdown-item ${isSelected ? 'active' : ''}`}
                  onClick={() => {
                    onSelectProfile(profile);
                    setOpen(false);
                  }}
                >
                  <div className="ai-model-item-icon">
                    <AiProviderIcon provider={profile.provider} size={14} />
                  </div>
                  <div className="ai-model-item-info">
                    <div className="ai-model-item-name">{profile.name}</div>
                    <div className="ai-model-item-sub">
                      {profile.provider} • {profile.model}
                    </div>
                  </div>
                  {isSelected && <span className="ai-model-item-check">✓</span>}
                </button>
              );
            })}
          </div>

          <div className="ai-model-dropdown-footer">
            <button
              className="ai-model-settings-shortcut"
              onClick={() => {
                setOpen(false);
                onOpenSettings();
              }}
            >
              <Settings size={12} />
              <span>Quản lý & Cấu hình API Keys...</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
