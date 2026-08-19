import React, { useState, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, ModalBody } from './Modal';
import { searchDocs, normalizeEngine, getDocSummary, getDocDescription, getParamDesc } from '../utils/docsService';
import type { DbEngine, DocCategory, DocEntry } from '../docsData/types';
import {
  Search,
  X,
  Copy,
  Check,
  ExternalLink,
  FileCode2,
  Terminal,
  Layers,
  Hash,
  Calendar,
  Braces,
  Sigma,
  Globe,
  HelpCircle,
  FolderTree,
  Database,
  Plus,
  Type,
  Boxes,
  Calculator,
  Workflow,
  Code2,
  Cpu,
} from 'lucide-react';

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
  'control_flow',
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
    case 'control_flow': return 'Control Flow';
    case 'spatial_vector': return t('docs.catSpatialVector');
    case 'command': return t('docs.catCommand');
    case 'pragma': return t('docs.catPragma');
    default: return String(cat);
  }
}

function getCategoryIcon(cat: DocCategory | 'all') {
  switch (cat) {
    case 'all': return <FolderTree size={13} />;
    case 'dml': return <Terminal size={13} />;
    case 'ddl': return <Layers size={13} />;
    case 'transaction': return <Boxes size={13} />;
    case 'string': return <Type size={13} />;
    case 'datetime': return <Calendar size={13} />;
    case 'json': return <Braces size={13} />;
    case 'aggregate': return <Sigma size={13} />;
    case 'window': return <Code2 size={13} />;
    case 'math': return <Calculator size={13} />;
    case 'control_flow': return <Workflow size={13} />;
    case 'spatial_vector': return <Globe size={13} />;
    case 'command': return <Cpu size={13} />;
    case 'pragma': return <Hash size={13} />;
    default: return <FileCode2 size={13} />;
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
  const [copiedTarget, setCopiedTarget] = useState<'syntax' | 'example' | null>(null);

  useEffect(() => {
    if (isOpen) {
      if (initialQuery) setQuery(initialQuery);
      if (initialEngine) {
        const norm = initialEngine === 'all' ? 'all' : normalizeEngine(initialEngine) || 'all';
        setEngine(norm);
      }
    }
  }, [isOpen, initialQuery, initialEngine]);

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { all: 0 };
    for (const cat of CATEGORIES) {
      counts[cat] = 0;
    }
    const matchingDocs = searchDocs({ query, engine, category: 'all' });
    counts.all = matchingDocs.length;
    for (const doc of matchingDocs) {
      if (counts[doc.category] !== undefined) {
        counts[doc.category]++;
      }
    }
    return counts;
  }, [query, engine]);

  const results = useMemo(() => {
    return searchDocs({ query, engine, category });
  }, [query, engine, category]);

  // Keep active doc valid
  const activeDoc: DocEntry | null = useMemo(() => {
    if (!results.length) return null;
    if (selectedDocId) {
      const found = results.find((d) => d.id === selectedDocId);
      if (found) return found;
    }
    return results[0];
  }, [results, selectedDocId]);

  if (!isOpen) return null;

  const handleCopyCode = (code: string, target: 'syntax' | 'example') => {
    navigator.clipboard.writeText(code);
    setCopiedTarget(target);
    setTimeout(() => setCopiedTarget(null), 2000);
  };

  const lang = i18n.language;

  return (
    <Modal
      title={t('docs.title')}
      onClose={onClose}
      width="1280px"
      height="840px"
      maxWidth="96vw"
      maxHeight="92vh"
      zIndex={10002}
    >
      <ModalBody className="doc-viewer-modal-body">
        {/* Topbar: Search Bar + Segmented Engine Selector */}
        <div className="doc-topbar">
          <div className="doc-search-box">
            <Search size={15} className="doc-search-icon" />
            <input
              type="text"
              className="doc-search-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('docs.searchPlaceholder')}
              autoFocus
            />
            {query && (
              <button className="doc-clear-btn" onClick={() => setQuery('')} title="Clear">
                <X size={13} />
              </button>
            )}
          </div>

          <div className="doc-engine-selector">
            {(['all', 'mysql', 'postgres', 'sqlite', 'redis'] as const).map((e) => {
              const active = engine === e;
              const label =
                e === 'all'
                  ? t('docs.allEngines')
                  : e === 'mysql'
                  ? 'MySQL'
                  : e === 'postgres'
                  ? 'PostgreSQL'
                  : e === 'sqlite'
                  ? 'SQLite'
                  : 'Redis';
              return (
                <button
                  key={e}
                  className={`doc-engine-btn ${active ? 'active' : ''}`}
                  onClick={() => setEngine(e)}
                >
                  {e === 'all' ? (
                    <Database size={13} />
                  ) : (
                    <span className={`doc-mini-dot ${e}`} />
                  )}
                  <span>{label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 3-Column Workspace: Category Sidebar | Command List | Detail View */}
        <div className="doc-workspace">
          {/* Column 1: Category Sidebar */}
          <aside className="doc-category-sidebar">
            <div className="doc-pane-header">
              <span>{t('docs.categoriesHeader')}</span>
              <span className="doc-header-count">{results.length}</span>
            </div>
            <div className="doc-category-list">
              {CATEGORIES.map((catKey) => {
                const active = category === catKey;
                const count = categoryCounts[catKey] || 0;
                return (
                  <button
                    key={catKey}
                    className={`doc-cat-item ${active ? 'active' : ''}`}
                    onClick={() => setCategory(catKey)}
                  >
                    <span className="doc-cat-icon">{getCategoryIcon(catKey)}</span>
                    <span className="doc-cat-label">{getCategoryLabel(catKey, t)}</span>
                    <span className="doc-cat-badge">{count}</span>
                  </button>
                );
              })}
            </div>
          </aside>

          {/* Column 2: Commands List */}
          <aside className="doc-list-sidebar">
            <div className="doc-pane-header">
              <span>{t('docs.commandsHeader')}</span>
              <span className="doc-header-count">{results.length}</span>
            </div>
            <div className="doc-list-container">
              {results.length === 0 ? (
                <div className="doc-empty-state">
                  <HelpCircle size={24} />
                  <p>{t('docs.noResults')}</p>
                </div>
              ) : (
                results.map((item) => {
                  const isSelected = activeDoc?.id === item.id;
                  return (
                    <div
                      key={item.id}
                      className={`doc-list-item ${isSelected ? 'active' : ''}`}
                      onClick={() => setSelectedDocId(item.id)}
                    >
                      <div className="doc-item-title-row">
                        <span className="doc-item-name">{item.name}</span>
                        <span className={`doc-badge-pill ${item.engine}`}>{item.engine}</span>
                      </div>
                      <div className="doc-item-summary" title={getDocSummary(item, lang)}>
                        {getDocSummary(item, lang)}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </aside>

          {/* Column 3: Doc Detail Pane */}
          <main className="doc-detail-pane">
            {activeDoc ? (
              <div className="doc-detail-content">
                {/* Header / Hero */}
                <div className="doc-hero">
                  <div className="doc-hero-main">
                    <div className="doc-hero-tags">
                      <span className={`doc-badge-pill ${activeDoc.engine}`}>{activeDoc.engine.toUpperCase()}</span>
                      <span className="doc-category-pill">{getCategoryLabel(activeDoc.category, t)}</span>
                      {activeDoc.since && <span className="doc-since-tag">{activeDoc.since}</span>}
                    </div>
                    <h1 className="doc-title">{activeDoc.name}</h1>
                    <p className="doc-summary-lead">{getDocSummary(activeDoc, lang)}</p>
                  </div>

                  {activeDoc.returns && (
                    <div className="doc-return-box">
                      <span className="doc-return-label">{t('docs.returns')}</span>
                      <code className="doc-return-val">{activeDoc.returns}</code>
                    </div>
                  )}
                </div>

                {/* Syntax Card */}
                <div className="doc-card">
                  <div className="doc-card-header">
                    <span className="doc-card-title">
                      <Terminal size={13} /> CÚ PHÁP (SYNTAX)
                    </span>
                    <button
                      className="doc-icon-action"
                      onClick={() => handleCopyCode(activeDoc.syntax, 'syntax')}
                      title={copiedTarget === 'syntax' ? t('docs.copiedExample') : t('common.close')}
                    >
                      {copiedTarget === 'syntax' ? <Check size={13} className="doc-ok-icon" /> : <Copy size={13} />}
                      <span>{copiedTarget === 'syntax' ? t('docs.copiedExample') : 'Copy'}</span>
                    </button>
                  </div>
                  <pre className="doc-code-block">
                    <code>{activeDoc.syntax}</code>
                  </pre>
                </div>

                {/* Detailed Description */}
                <div className="doc-card doc-desc-card">
                  <p className="doc-full-desc">{getDocDescription(activeDoc, lang)}</p>
                  {activeDoc.complexity && (
                    <div className="doc-complexity-row">
                      <span>⏱ {t('docs.timeComplexity')}:</span>{' '}
                      <code>{activeDoc.complexity}</code>
                    </div>
                  )}
                </div>

                {/* Parameters Table */}
                {activeDoc.params && activeDoc.params.length > 0 && (
                  <div className="doc-card">
                    <div className="doc-card-header">
                      <span className="doc-card-title">
                        <Layers size={13} /> {t('docs.parameters')} ({activeDoc.params.length})
                      </span>
                    </div>
                    <div className="doc-table-wrapper">
                      <table className="doc-params-table">
                        <thead>
                          <tr>
                            <th>{t('docs.paramName')}</th>
                            <th>{t('docs.paramType')}</th>
                            <th>{t('docs.paramRequired')}</th>
                            <th>{t('docs.paramDescription')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {activeDoc.params.map((p, i) => (
                            <tr key={i}>
                              <td className="doc-param-name"><code>{p.name}</code></td>
                              <td className="doc-param-type"><code>{p.type || 'any'}</code></td>
                              <td className="doc-param-req">
                                {p.optional ? (
                                  <span className="doc-opt-badge">{t('docs.paramOptionalBadge')}</span>
                                ) : (
                                  <span className="doc-req-badge">{t('docs.paramRequiredBadge')}</span>
                                )}
                              </td>
                              <td className="doc-param-desc">{getParamDesc(p, lang)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Examples Card */}
                {activeDoc.examples && activeDoc.examples.length > 0 && (
                  <div className="doc-card">
                    <div className="doc-card-header">
                      <span className="doc-card-title">
                        <FileCode2 size={13} /> {t('docs.examples')}
                      </span>
                      <div className="doc-example-actions">
                        <button
                          className="doc-icon-action"
                          onClick={() => handleCopyCode(activeDoc.examples[0], 'example')}
                        >
                          {copiedTarget === 'example' ? <Check size={13} className="doc-ok-icon" /> : <Copy size={13} />}
                          <span>{copiedTarget === 'example' ? t('docs.copiedExample') : 'Copy'}</span>
                        </button>
                        {onInsertCode && (
                          <button
                            className="doc-insert-btn"
                            onClick={() => {
                              onInsertCode(activeDoc.examples[0]);
                              onClose();
                            }}
                          >
                            <Plus size={13} /> {t('docs.insertExample')}
                          </button>
                        )}
                      </div>
                    </div>
                    <pre className="doc-code-block doc-example-code">
                      <code>{activeDoc.examples[0]}</code>
                    </pre>
                  </div>
                )}

                {/* Official Reference Footer */}
                {activeDoc.officialUrl && (
                  <div className="doc-footer-link">
                    <a href={activeDoc.officialUrl} target="_blank" rel="noreferrer" className="doc-external-link">
                      <span>{t('docs.officialDocs')}</span>
                      <ExternalLink size={12} />
                    </a>
                  </div>
                )}
              </div>
            ) : (
              <div className="doc-empty-detail">
                <HelpCircle size={36} />
                <p>{t('docs.selectToView')}</p>
              </div>
            )}
          </main>
        </div>
      </ModalBody>
    </Modal>
  );
};
