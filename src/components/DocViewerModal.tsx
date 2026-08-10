import React, { useState, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, ModalBody, ModalFooter } from './Modal';
import { searchDocs, normalizeEngine, getDocSummary, getDocDescription, getParamDesc } from '../utils/docsService';
import type { DbEngine, DocCategory, DocEntry } from '../docsData/types';

interface DocViewerModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialQuery?: string;
  initialEngine?: DbEngine | 'all' | string;
  onInsertCode?: (code: string) => void;
}

const CATEGORIES: (DocCategory | 'all')[] = [
  'all',
  'dml',
  'ddl',
  'transaction',
  'string',
  'datetime',
  'json',
  'aggregate',
  'window',
  'math',
  'spatial_vector',
  'command',
  'pragma',
];

function getCategoryLabel(cat: DocCategory | 'all', t: (key: any) => string): string {
  switch (cat) {
    case 'all': return t('docs.catAll');
    case 'dml': return t('docs.catDml');
    case 'ddl': return t('docs.catDdl');
    case 'transaction': return t('docs.catTransaction');
    case 'string': return t('docs.catString');
    case 'datetime': return t('docs.catDatetime');
    case 'json': return t('docs.catJson');
    case 'aggregate': return t('docs.catAggregate');
    case 'window': return t('docs.catWindow');
    case 'math': return t('docs.catMath');
    case 'spatial_vector': return t('docs.catSpatialVector');
    case 'command': return t('docs.catCommand');
    case 'pragma': return t('docs.catPragma');
    default: return String(cat);
  }
}

export const DocViewerModal: React.FC<DocViewerModalProps> = ({
  isOpen,
  onClose,
  initialQuery = '',
  initialEngine = 'all',
  onInsertCode,
}) => {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState(initialQuery);
  const [engine, setEngine] = useState<DbEngine | 'all'>(() => {
    if (initialEngine === 'all') return 'all';
    return normalizeEngine(initialEngine) || 'all';
  });
  const [category, setCategory] = useState<DocCategory | 'all'>('all');
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (isOpen) {
      if (initialQuery) setQuery(initialQuery);
      if (initialEngine) {
        const norm = initialEngine === 'all' ? 'all' : normalizeEngine(initialEngine) || 'all';
        setEngine(norm);
      }
    }
  }, [isOpen, initialQuery, initialEngine]);

  const results = useMemo(() => {
    return searchDocs({ query, engine, category });
  }, [query, engine, category]);

  // Keep selectedDoc valid
  const activeDoc: DocEntry | null = useMemo(() => {
    if (!results.length) return null;
    if (selectedDocId) {
      const found = results.find((d) => d.id === selectedDocId);
      if (found) return found;
    }
    return results[0];
  }, [results, selectedDocId]);

  if (!isOpen) return null;

  const getEngineBadge = (e: DbEngine) => {
    switch (e) {
      case 'mysql':
        return { name: 'MySQL', bg: '#0284c7', color: '#fff' };
      case 'postgres':
        return { name: 'Postgres', bg: '#2563eb', color: '#fff' };
      case 'sqlite':
        return { name: 'SQLite', bg: '#0f766e', color: '#fff' };
      case 'redis':
        return { name: 'Redis', bg: '#dc2626', color: '#fff' };
    }
  };

  const handleCopyExample = (code: string) => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const lang = i18n.language;

  return (
    <Modal
      title={t('docs.title')}
      onClose={onClose}
      width="1120px"
      height="780px"
      maxWidth="97vw"
      maxHeight="95vh"
      zIndex={10002}
    >
      <ModalBody style={{ display: 'flex', flexDirection: 'column', gap: '14px', overflow: 'hidden', padding: '16px' }}>
        {/* Search & Engine Selector Header */}
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('docs.searchPlaceholder')}
            autoFocus
            style={{
              flex: 1,
              minWidth: '260px',
              padding: '9px 14px',
              borderRadius: '6px',
              border: '1px solid var(--win-border)',
              background: 'var(--win-bg-input, var(--win-bg-window))',
              color: 'var(--win-text-primary)',
              fontSize: '13px',
              outline: 'none',
            }}
          />

          {/* Engine Tabs */}
          <div style={{ display: 'flex', gap: '4px', background: 'var(--win-bg-tab-bar, rgba(0,0,0,0.2))', padding: '4px', borderRadius: '6px' }}>
            {(['all', 'mysql', 'postgres', 'sqlite', 'redis'] as const).map((e) => {
              const active = engine === e;
              return (
                <button
                  key={e}
                  onClick={() => setEngine(e)}
                  style={{
                    padding: '5px 12px',
                    fontSize: '12px',
                    fontWeight: active ? 600 : 400,
                    borderRadius: '4px',
                    border: 'none',
                    background: active ? 'var(--win-accent)' : 'transparent',
                    color: active ? '#fff' : 'var(--win-text-secondary)',
                    cursor: 'pointer',
                    textTransform: 'capitalize',
                  }}
                >
                  {e === 'all' ? t('docs.allEngines') : e}
                </button>
              );
            })}
          </div>
        </div>

        {/* Category Chips */}
        <div style={{ display: 'flex', gap: '6px', overflowX: 'auto', paddingBottom: '4px' }}>
          {CATEGORIES.map((catKey) => {
            const active = category === catKey;
            return (
              <button
                key={catKey}
                onClick={() => setCategory(catKey)}
                style={{
                  padding: '4px 10px',
                  fontSize: '11px',
                  borderRadius: '12px',
                  border: '1px solid var(--win-border)',
                  background: active ? 'var(--win-accent-subtle, rgba(59,130,246,0.2))' : 'transparent',
                  color: active ? 'var(--win-accent)' : 'var(--win-text-secondary)',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                {getCategoryLabel(catKey, t)}
              </button>
            );
          })}
        </div>

        {/* Main Content Pane: Left List + Right Detail */}
        <div style={{ flex: 1, display: 'flex', gap: '14px', minHeight: 0, border: '1px solid var(--win-border)', borderRadius: '6px', overflow: 'hidden' }}>
          {/* Left Column: Doc List */}
          <div style={{ width: '340px', borderRight: '1px solid var(--win-border)', overflowY: 'auto', background: 'var(--win-bg-tab-bar, rgba(0,0,0,0.15))' }}>
            {results.length === 0 ? (
              <div style={{ padding: '20px', fontSize: '12px', color: 'var(--win-text-secondary)', textAlign: 'center' }}>
                {t('docs.noResults')}
              </div>
            ) : (
              results.map((item) => {
                const isSelected = activeDoc?.id === item.id;
                const badge = getEngineBadge(item.engine);
                return (
                  <div
                    key={item.id}
                    onClick={() => setSelectedDocId(item.id)}
                    style={{
                      padding: '10px 14px',
                      cursor: 'pointer',
                      borderBottom: '1px solid var(--win-border-subtle, rgba(255,255,255,0.06))',
                      background: isSelected ? 'var(--win-accent-subtle, rgba(59,130,246,0.2))' : 'transparent',
                      borderLeft: isSelected ? '4px solid var(--win-accent)' : '4px solid transparent',
                      transition: 'background 0.15s ease',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                      <span style={{ fontSize: '13px', fontWeight: isSelected ? 700 : 600, fontFamily: 'var(--win-font-mono)', color: isSelected ? 'var(--win-accent)' : 'var(--win-text-primary)' }}>
                        {item.name}
                      </span>
                      <span style={{ fontSize: '10px', padding: '2px 7px', borderRadius: '4px', background: badge.bg, color: badge.color, fontWeight: 700, letterSpacing: '0.3px' }}>
                        {badge.name}
                      </span>
                    </div>
                    <div style={{ fontSize: '11px', color: isSelected ? 'var(--win-text-primary)' : 'var(--win-text-secondary)', marginTop: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: isSelected ? 1 : 0.85 }}>
                      {getDocSummary(item, lang)}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Right Column: Doc Detail */}
          <div style={{ flex: 1, padding: '20px', overflowY: 'auto', background: 'var(--win-bg-window)' }}>
            {activeDoc ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {/* Title & Engine Badge */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px' }}>
                  <div>
                    <h2 style={{ margin: 0, fontSize: '22px', fontWeight: 700, fontFamily: 'var(--win-font-mono)', color: 'var(--win-text-primary)' }}>
                      {activeDoc.name}
                    </h2>
                    <span style={{ fontSize: '12px', color: 'var(--win-text-secondary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                      Category: {activeDoc.category}
                    </span>
                  </div>
                  {activeDoc.since && (
                    <span style={{ fontSize: '12px', padding: '4px 10px', borderRadius: '4px', background: 'var(--win-bg-tab-bar)', color: 'var(--win-text-secondary)', fontWeight: 500 }}>
                      {t('docs.since')}: {activeDoc.since}
                    </span>
                  )}
                </div>

                {/* Syntax Box */}
                <div style={{ background: 'var(--win-bg-code, #1e1e1e)', color: '#d4d4d4', padding: '12px 16px', borderRadius: '6px', fontFamily: 'var(--win-font-mono)', fontSize: '12.5px', border: '1px solid var(--win-border)' }}>
                  <div style={{ fontSize: '10px', color: '#808080', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Syntax</div>
                  <code>{activeDoc.syntax}</code>
                </div>

                {/* Summary & Description */}
                <div>
                  <p style={{ margin: '0 0 8px 0', fontSize: '14px', fontWeight: 600, color: 'var(--win-text-primary)' }}>
                    {getDocSummary(activeDoc, lang)}
                  </p>
                  <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.6, color: 'var(--win-text-secondary)' }}>
                    {getDocDescription(activeDoc, lang)}
                  </p>
                </div>

                {/* Time Complexity (Redis) */}
                {activeDoc.complexity && (
                  <div style={{ fontSize: '12px', color: '#f59e0b', fontWeight: 600 }}>
                    ⏱ {t('docs.timeComplexity')}: <code>{activeDoc.complexity}</code>
                  </div>
                )}

                {/* Parameters List */}
                {activeDoc.params && activeDoc.params.length > 0 && (
                  <div>
                    <h4 style={{ margin: '0 0 8px 0', fontSize: '13px', fontWeight: 600, color: 'var(--win-text-primary)' }}>
                      {t('docs.parameters')}
                    </h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      {activeDoc.params.map((p, i) => (
                        <div key={i} style={{ fontSize: '12px', padding: '8px 12px', background: 'var(--win-bg-subtle, rgba(0,0,0,0.1))', borderRadius: '5px', border: '1px solid var(--win-border)' }}>
                          <span style={{ fontFamily: 'var(--win-font-mono)', fontWeight: 700, color: 'var(--win-accent)' }}>
                            {p.name}
                          </span>
                          {p.type && <span style={{ opacity: 0.8, marginLeft: '6px', fontSize: '11px', color: 'var(--win-text-secondary)' }}>({p.type})</span>}
                          {p.optional && <span style={{ opacity: 0.6, marginLeft: '4px', fontSize: '10.5px', color: 'var(--win-text-secondary)' }}>optional</span>}: <span style={{ color: 'var(--win-text-primary)' }}>{getParamDesc(p, lang)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Return Type */}
                {activeDoc.returns && (
                  <div style={{ fontSize: '12.5px', color: 'var(--win-text-secondary)' }}>
                    <strong>{t('docs.returns')}:</strong> <code style={{ color: 'var(--win-accent)' }}>{activeDoc.returns}</code>
                  </div>
                )}

                {/* Usage Examples */}
                {activeDoc.examples && activeDoc.examples.length > 0 && (
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                      <h4 style={{ margin: 0, fontSize: '13px', fontWeight: 600, color: 'var(--win-text-primary)' }}>
                        {t('docs.examples')}
                      </h4>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button
                          onClick={() => handleCopyExample(activeDoc.examples[0])}
                          className="btn btn-secondary"
                          style={{ padding: '3px 10px', fontSize: '11px' }}
                        >
                          {copied ? t('docs.copiedExample') : t('common.copy')}
                        </button>
                        {onInsertCode && (
                          <button
                            onClick={() => {
                              onInsertCode(activeDoc.examples[0]);
                              onClose();
                            }}
                            className="btn btn-primary"
                            style={{ padding: '3px 10px', fontSize: '11px' }}
                          >
                            {t('docs.insertExample')}
                          </button>
                        )}
                      </div>
                    </div>
                    <pre style={{ margin: 0, background: 'var(--win-bg-code, #1e1e1e)', color: '#9cdcfe', padding: '12px 16px', borderRadius: '6px', fontSize: '12px', fontFamily: 'var(--win-font-mono)', overflowX: 'auto', border: '1px solid var(--win-border)' }}>
                      {activeDoc.examples[0]}
                    </pre>
                  </div>
                )}

                {/* Official Link */}
                {activeDoc.officialUrl && (
                  <div style={{ marginTop: 'auto', paddingTop: '10px' }}>
                    <a
                      href={activeDoc.officialUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{ fontSize: '12px', color: 'var(--win-accent)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                    >
                      🔗 {t('docs.officialDocs')} ↗
                    </a>
                  </div>
                )}
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--win-text-disabled)', fontSize: '12px' }}>
                Select a function or command to view documentation.
              </div>
            )}
          </div>
        </div>
      </ModalBody>

      <ModalFooter>
        <button className="btn btn-secondary" onClick={onClose}>
          {t('common.close')}
        </button>
      </ModalFooter>
    </Modal>
  );
};
