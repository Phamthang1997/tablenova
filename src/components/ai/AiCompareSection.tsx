import React from 'react';
import { useTranslation } from 'react-i18next';
import { AiProviderIcon } from './AiIcons';
import type { AiAssistantProfile } from '../../utils/aiConfig';

interface AiCompareSectionProps {
  currentAssistantId?: string;
  profiles: AiAssistantProfile[];
  onCompareWith: (profile: AiAssistantProfile) => void;
  loading?: boolean;
}

export const AiCompareSection: React.FC<AiCompareSectionProps> = ({
  currentAssistantId,
  profiles,
  onCompareWith,
  loading = false,
}) => {
  const { t } = useTranslation();

  // Filter other enabled profiles that are not the current assistant
  const compareCandidates = profiles.filter(
    (p) => p.id !== currentAssistantId && p.enabled !== false
  );

  if (compareCandidates.length === 0) return null;

  return (
    <div className="ai-compare-container">
      <div className="ai-compare-title">
        {t('ai.compareTitle', 'You can compare this answer with...')}
      </div>
      <div className="ai-compare-list">
        {compareCandidates.map((profile) => (
          <button
            key={profile.id}
            className="ai-compare-btn"
            onClick={() => onCompareWith(profile)}
            disabled={loading}
          >
            <div className="ai-compare-btn-icon">
              <AiProviderIcon provider={profile.provider} size={14} />
            </div>
            <span className="ai-compare-btn-name">{profile.name}</span>
            <span className="ai-compare-btn-model">({profile.model})</span>
          </button>
        ))}
      </div>
    </div>
  );
};
