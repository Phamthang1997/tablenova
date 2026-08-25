import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen } from 'lucide-react';
import { dbHelper } from '../utils/dbHelper';
import { getLastExportDir, pickExportFolder } from '../utils/fileSave';
import { fileStamp, missingViewDeps, safeFileBase } from '../utils/exportHelper';
import { Modal, ModalFooter } from './Modal';

export type DatabaseExportFormat = 'sql' | 'json' | 'csv' | 'xlsx';

export interface DatabaseExportOptions {
  format: DatabaseExportFormat;
  tables: string[];
  /**
   * Tên nào in `tables` is VIEW chứ not must table. Dump SQL must create view SAU toàn bộ
   * table and not xuất dữ liệu of view — xem `orderViewsByDependency` at exportHelper.ts.
   */
  views: string[];
  /**
   * Function/procedure is select. Chỉ có nghĩa with định dạng SQL and when bật "kèm cấu trúc";
   * dump write chúng SAU table and view vì thân routine tham chiếu tới đó.
   */
  routines: { name: string; kind: 'function' | 'procedure' }[];
  /** Trigger is select — write cuối cùng, sau cả routine (trigger can gọi hàm). */
  triggers: string[];
  /** MySQL scheduled event; Postgres/SQLite not có nên luôn rỗng. */
  events: string[];
  filename: string;
  sqlOptions: { dropTable: boolean; includeStructure: boolean; includeContent: boolean };
  compressGzip: boolean;
  /** Thư mục save tệp; null = download qua WebView về thư mục download xuống of hệ thống. */
  dir: string | null;
  // not còn tham số tiến độ: lần xuất run như job nền (utils/jobs.ts) and báo tiến độ ando
  // JobsTray. Popup close ngay when job is xếp, nên một callback ando đây chỉ vẽ for not ai xem.
}

interface ExportDatabaseDialogProps {
  /** Kết nối mà component này thao tác lên. Truyền tường minh, not read id ambient (§4.1). */
  connId: string;
  open: boolean;
  onClose: () => void;
  /** returns true if xuất xong (popup tự close), false to giữ popup lại for user edit. */
  onSubmit: (options: DatabaseExportOptions) => Promise<boolean>;
  /** Database currently open — dùng to suggestion tên tệp when xuất nhiều đối tượng. */
  dbName?: string;
}

const FORMAT_LABEL: Record<DatabaseExportFormat, string> = {
  sql: 'SQL',
  json: 'JSON',
  csv: 'CSV (ZIP)',
  xlsx: 'XLSX',
};

/** Translation keys for the per-format hint; resolved with `t()` in the component. */
const FORMAT_HINT_KEY = {
  sql: 'exportDialog.descSql',
  json: 'exportDialog.descJson',
  csv: 'exportDialog.descCsv',
  xlsx: 'exportDialog.descXlsx',
} as const satisfies Record<DatabaseExportFormat, string>;

const labelStyle: React.CSSProperties = {
  fontSize: '11px',
  fontWeight: 600,
  color: 'var(--win-text-secondary)',
  display: 'block',
  marginBottom: '6px',
};

/**
 * Một row in danh sách select. Kèm `kind` vì tên not đủ to định danh: một database can
 * có table `payment` and trigger `payment` cùng lúc, and mỗi loại is write ando dump theo một cách
 * khác nhau (table có dữ liệu, view chỉ định nghĩa, routine/trigger must bọc DELIMITER).
 */
type ExportObjKind = 'table' | 'view' | 'function' | 'procedure' | 'trigger' | 'event';
interface ExportObj {
  name: string;
  kind: ExportObjKind;
  /** table chủ of trigger (chỉ có with kind === 'trigger'). */
  table?: string;
}
const objKey = (o: ExportObj) => `${o.kind}:${o.name}`;

/** Nhãn nhỏ cạnh tên; table not có nhãn vì đó is trường hợp default. */
const BADGE_KEY = {
  view: 'exportDialog.viewBadge',
  function: 'exportDialog.funcBadge',
  procedure: 'exportDialog.procBadge',
  trigger: 'exportDialog.triggerBadge',
  event: 'exportDialog.eventBadge',
} as const satisfies Record<Exclude<ExportObjKind, 'table'>, string>;

/**
 * Thứ tự nhóm in danh sách, cũng is thứ tự write ando dump.
 *
 * Danh sách is chia nhóm chứ not to phẳng: một database cỡ sakila có hơn hai chục table
 * đứng trước, nên routine and trigger rơi xuống under đáy vùng cuộn and user tưatng is
 * chúng not is xuất. row tóm tắt phía on danh sách cũng vì lý do đó — nó nói ngay có
 * bao nhiêu đối tượng mỗi loại mà not cần cuộn.
 */
const KIND_ORDER = ['table', 'view', 'function', 'procedure', 'event', 'trigger'] as const;
const LABEL_KEY = {
  table: 'exportDialog.tableBadge',
  ...BADGE_KEY,
} as const satisfies Record<ExportObjKind, string>;

// Routine/trigger chỉ xuất is ra .sql — các định dạng còn lại is dữ liệu table.
const isSqlOnlyKind = (k: ExportObjKind) => k !== 'table' && k !== 'view';

// Bỏ dấu to find table not phân biệt dấu (giống ô search at Sidebar).
const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g');
const removeAccents = (s: string) =>
  s.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase();

/**
 * Popup "Xuất database" — layout 2 column: trái is configuration (tên tệp, định dạng,
 * option SQL), must is table list chiếm hết height nên not must cuộn cả popup.
 */
export const ExportDatabaseDialog: React.FC<ExportDatabaseDialogProps> = ({ connId, open, onClose, onSubmit, dbName }) => {
  const { t } = useTranslation();
  // Tên tệp suggestion theo lựa select, nhưng user gõ tay is stop suggestion (`filenameTouched`) —
  // not thì mỗi lần tick add một table lại delete mất tên họ vừa đặt.
  const [filename, setFilename] = useState('');
  const [filenameTouched, setFilenameTouched] = useState(false);
  // Dấu time chốt MỘT lần lúc open popup: if tính lại theo fromng lần render thì con số
  // in ô nhảy liên tục in lúc user currently tick select.
  const [stamp, setStamp] = useState('');
  const [format, setFormat] = useState<DatabaseExportFormat>('sql');
  const [dropTable, setDropTable] = useState(true);
  const [includeStructure, setIncludeStructure] = useState(true);
  const [includeContent, setIncludeContent] = useState(true);
  const [compressGzip, setCompressGzip] = useState(false);
  // table + view + function/procedure + trigger, theo thứ tự will is write ando dump.
  const [objects, setObjects] = useState<ExportObj[]>([]);
  // key `kind:name`, not must tên trần — xem ExportObj.
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [tablesLoading, setTablesLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dir, setDir] = useState(getLastExportDir());
  // DDL of fromng view, load nền sau when có danh sách — chỉ dùng to warning thiếu table nguồn.
  const [viewDefs, setViewDefs] = useState<{ name: string; sql: string }[]>([]);

  useEffect(() => {
    if (!open) return;
    setSearch('');
    setError(null);
    setFilenameTouched(false);
    setStamp(fileStamp());
    setTablesLoading(true);
    let cancelled = false;
    (async () => {
      // Ba nguồn: getTables (table+view), getDatabaseObjects (routine), getAllTriggers.
      // Routine/trigger not lấy is thì trả mảng rỗng chứ not ism hỏng cả popup.
      const [list, dbObjs, triggers] = await Promise.all([
        dbHelper.getTables(connId),
        dbHelper.getDatabaseObjects(connId),
        dbHelper.getAllTriggers(connId),
      ]);
      if (cancelled) return;
      // not đặt tên tham số is `t` — đó is hàm dịch.
      const viewSet = new Set(list.filter((item) => item.type === 'view').map((item) => item.name));
      const all: ExportObj[] = [
        ...list.map((item) => ({ name: item.name, kind: viewSet.has(item.name) ? ('view' as const) : ('table' as const) })),
        ...dbObjs.functions.map((name) => ({ name, kind: 'function' as const })),
        ...dbObjs.procedures.map((name) => ({ name, kind: 'procedure' as const })),
        ...dbObjs.events.map((name) => ({ name, kind: 'event' as const })),
        ...triggers.map((tr) => ({ name: tr.name, kind: 'trigger' as const, table: tr.table })),
      ];
      setObjects(all);
      setSelected(all.map(objKey));
      setTablesLoading(false);

      // load DDL of view sau, not chặn danh sách: nó chỉ phục vụ warning "view thiếu table
      // nguồn", and mỗi view is một lần gọi backend nên not đáng bắt user wait.
      const viewNames = [...viewSet];
      if (viewNames.length > 0) {
        const defs = await Promise.all(
          viewNames.map(async (name) => {
            const def = await dbHelper.getTableDefinition(connId, name);
            return { name, sql: def.success && def.sql ? def.sql : '' };
          })
        );
        if (!cancelled) setViewDefs(defs.filter((d) => d.sql));
      }
    })();
    return () => { cancelled = true; };
  }, [connId, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !submitting) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, submitting]);

  if (!open) return null;

  // Định dạng not must SQL chỉ xuất is dữ liệu table -> routine/trigger biến khỏi danh sách
  // (vẫn giữ in `selected` to select lại SQL is còn nguyên lựa select cũ).
  const listable = format === 'sql' ? objects : objects.filter((o) => !isSqlOnlyKind(o.kind));
  const shown = search.trim()
    ? listable.filter((o) => removeAccents(o.name).includes(removeAccents(search.trim())))
    : listable;
  const allShownSelected = shown.length > 0 && shown.every((o) => selected.includes(objKey(o)));

  /**
   * Trigger đi theo table chủ of nó.
   *
   * `mysqldump` default xuất trigger cùng with table, and đó cũng is điều user wait đợi:
   * deselect hết rồi tick đúng một table thì trigger of table đó must nằm in dump. Trigger
   * vẫn có row riêng to deselect lẻ is, nhưng thao tác on table thì kéo theo cả chúng.
   */
  const triggerKeysOf = (tableName: string) =>
    objects
      .filter((o) => o.kind === 'trigger' && (o.table || '').toLowerCase() === tableName.toLowerCase())
      .map(objKey);

  const keysWithTriggers = (items: ExportObj[]) => [
    ...items.map(objKey),
    ...items.filter((o) => o.kind === 'table').flatMap((o) => triggerKeysOf(o.name)),
  ];

  const toggleAllShown = () => {
    const keys = keysWithTriggers(shown);
    if (allShownSelected) setSelected(selected.filter((k) => !keys.includes(k)));
    else setSelected([...new Set([...selected, ...keys])]);
  };

  const toggleOne = (key: string) => {
    const target = objects.find((o) => objKey(o) === key);
    const keys = target ? keysWithTriggers([target]) : [key];
    setSelected((prev) =>
      prev.includes(key) ? prev.filter((k) => !keys.includes(k)) : [...new Set([...prev, ...keys])]
    );
  };

  /**
   * select đúng MỘT đối tượng -> lấy tên đối tượng đó; nhiều hơn -> lấy tên database.
   * Kèm dấu time to hai lần xuất liên tiếp not write đè lên nhau.
   */
  const chosenNow = listable.filter((o) => selected.includes(objKey(o)));
  const suggestedName = `${safeFileBase(
    chosenNow.length === 1 ? chosenNow[0].name : dbName || 'database'
  )}_${stamp}`;
  const effectiveFilename = filenameTouched ? filename : suggestedName;

  // Nhóm theo loại, giữ thứ tự KIND_ORDER; loại nào not có đối tượng thì biến mất hẳn.
  const groups = KIND_ORDER
    .map((kind) => ({ kind, items: shown.filter((o) => o.kind === kind) }))
    .filter((g) => g.items.length > 0);

  // Chip đếm at on cũng is nút select/bỏ cả nhóm.
  const kindItems = (kind: ExportObjKind) => listable.filter((o) => o.kind === kind);
  const isKindFullySelected = (kind: ExportObjKind) => {
    const items = kindItems(kind);
    return items.length > 0 && items.every((o) => selected.includes(objKey(o)));
  };
  const toggleKind = (kind: ExportObjKind) => {
    const keys = keysWithTriggers(kindItems(kind));
    const on = isKindFullySelected(kind);
    setSelected((prev) =>
      on ? prev.filter((k) => !keys.includes(k)) : [...new Set([...prev, ...keys])]
    );
  };

  // warning (not tự tích add): view is select mà table nó read thì not.
  const selectedNames = new Set(chosenNow.map((o) => o.name.toLowerCase()));
  const tableNames = objects.filter((o) => o.kind === 'table').map((o) => o.name);
  const viewWarnings =
    format === 'sql' && includeStructure
      ? missingViewDeps(
          viewDefs.filter((v) => selectedNames.has(v.name.toLowerCase())),
          tableNames,
          selectedNames
        )
      : [];

  const submit = async () => {
    const chosen = chosenNow;
    if (chosen.length === 0) {
      setError(t('exportDialog.errPickTable'));
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const ok = await onSubmit({
        format,
        // preserve hợp đồng cũ: `tables` gồm cả view, `views` chỉ đánh dấu cái nào is view.
        tables: chosen.filter((o) => o.kind === 'table' || o.kind === 'view').map((o) => o.name),
        views: chosen.filter((o) => o.kind === 'view').map((o) => o.name),
        routines: chosen
          .filter((o): o is ExportObj & { kind: 'function' | 'procedure' } => o.kind === 'function' || o.kind === 'procedure')
          .map((o) => ({ name: o.name, kind: o.kind })),
        triggers: chosen.filter((o) => o.kind === 'trigger').map((o) => o.name),
        events: chosen.filter((o) => o.kind === 'event').map((o) => o.name),
        filename: effectiveFilename.trim() || suggestedName,
        sqlOptions: { dropTable, includeStructure, includeContent },
        compressGzip,
        dir: dir || null,
      });
      if (ok) onClose();
    } finally {
      setSubmitting(false);
    }
  };

  const chooseFolder = async () => {
    const picked = await pickExportFolder(dir || undefined);
    if (picked) setDir(picked);
  };

  return (
    <Modal
      title={t('exportDialog.dbTitle')}
      onClose={onClose}
      closeDisabled={submitting}
      width="820px"
      height="540px"
      zIndex={9999}
    >
      {/* Thân: 2 column — configuration | table list */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div style={{
          width: '340px',
          flexShrink: 0,
          borderRight: '1px solid var(--win-border)',
          padding: '16px',
          display: 'flex',
          flexDirection: 'column',
          gap: '14px',
          overflowY: 'auto'
        }}>
          <div className="form-group">
            <label style={labelStyle}>{t('exportDialog.fileName')}</label>
            <input
              type="text"
              className="form-input"
              value={effectiveFilename}
              onChange={(e) => {
                setFilenameTouched(true);
                setFilename(e.target.value);
              }}
              placeholder={suggestedName}
              style={{ height: '30px', fontSize: '11px', width: '100%' }}
            />
          </div>

          <div className="form-group">
            <label style={labelStyle}>{t('exportDialog.saveFolder')}</label>
            <div style={{ display: 'flex', gap: '6px' }}>
              <input
                type="text"
                className="form-input"
                readOnly
                value={dir}
                placeholder={t('exportDialog.folderPlaceholder')}
                onClick={chooseFolder}
                title={dir || t('exportDialog.pickFolderTitle')}
                style={{ flex: 1, minWidth: 0, height: '30px', fontSize: '11px', cursor: 'pointer' }}
              />
              <button
                className="btn btn-secondary"
                onClick={chooseFolder}
                disabled={submitting}
                style={{ padding: '0 10px', display: 'flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' }}
              >
                <FolderOpen size={13} />
                {t('exportDialog.pick')}
              </button>
              {dir && (
                <button className="btn btn-secondary" onClick={() => setDir('')} disabled={submitting} style={{ padding: '0 10px' }}>
                  {t('exportDialog.clear')}
                </button>
              )}
            </div>
          </div>

          <div>
            <label style={labelStyle}>{t('exportDialog.formatLabel')}</label>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {(['sql', 'json', 'csv', 'xlsx'] as const).map((fmt) => (
                <button
                  key={fmt}
                  onClick={() => setFormat(fmt)}
                  style={{
                    padding: '6px 12px',
                    fontSize: '11px',
                    borderRadius: '4px',
                    border: '1px solid var(--win-border)',
                    cursor: 'pointer',
                    background: format === fmt ? 'var(--win-accent)' : 'transparent',
                    color: format === fmt ? '#fff' : 'var(--win-text-secondary)',
                    fontWeight: 600
                  }}
                >
                  {FORMAT_LABEL[fmt]}
                </button>
              ))}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)', marginTop: '8px', lineHeight: 1.5 }}>
              {t(FORMAT_HINT_KEY[format])}
            </div>
          </div>

          {format === 'sql' && (
            <div>
              <label style={labelStyle}>{t('exportDialog.sqlOptions')}</label>
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                padding: '10px',
                background: 'var(--win-bg-window)',
                border: '1px solid var(--win-border)',
                borderRadius: '4px'
              }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={dropTable} onChange={(e) => setDropTable(e.target.checked)} />
                  <span>{t('exportDialog.optDropTable')}</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={includeStructure} onChange={(e) => setIncludeStructure(e.target.checked)} />
                  <span>{t('exportDialog.optStructure')}</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={includeContent} onChange={(e) => setIncludeContent(e.target.checked)} />
                  <span>{t('exportDialog.optData')}</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={compressGzip} onChange={(e) => setCompressGzip(e.target.checked)} />
                  <span>{t('exportDialog.optGzip')}</span>
                </label>
              </div>
            </div>
          )}
        </div>

        <div style={{ flex: 1, minWidth: 0, padding: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
            <label style={{ ...labelStyle, marginBottom: 0 }}>
              {t('exportDialog.objectsToExport', { selected: selected.length, total: objects.length })}
            </label>
            <button
              onClick={toggleAllShown}
              disabled={shown.length === 0}
              style={{
                padding: '2px 8px',
                fontSize: '10px',
                cursor: 'pointer',
                background: 'var(--win-bg-card)',
                border: '1px solid var(--win-border)',
                borderRadius: '3px',
                color: 'var(--win-text-primary)',
                whiteSpace: 'nowrap'
              }}
            >
              {allShownSelected ? t('exportDialog.deselectAll') : t('exportDialog.selectAll')}
            </button>
          </div>

          <input
            type="text"
            className="form-input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('exportDialog.searchTables')}
            style={{ height: '28px', fontSize: '11px', width: '100%' }}
          />

          {/* Tóm tắt số lượng theo loại — nằm NGOÀI vùng cuộn, to biết ngay có routine/trigger
              hay not mà not must kéo qua hết table list. */}
          {!tablesLoading && objects.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
              {KIND_ORDER.map((kind) => {
                const n = kindItems(kind).length;
                if (n === 0) return null;
                const all = isKindFullySelected(kind);
                return (
                  <button
                    key={kind}
                    onClick={() => toggleKind(kind)}
                    title={t('exportDialog.toggleGroup')}
                    style={{
                      fontSize: '9px',
                      fontWeight: 600,
                      padding: '1px 5px',
                      borderRadius: '3px',
                      cursor: 'pointer',
                      border: '1px solid var(--win-border)',
                      background: all ? 'var(--win-accent)' : 'transparent',
                      color: all ? '#fff' : 'var(--win-text-secondary)',
                    }}
                  >{t(LABEL_KEY[kind])} {n}</button>
                );
              })}
            </div>
          )}

          {/* Chỉ warning, not tự tích add: xuất một phần is nhu cầu chính đáng. */}
          {viewWarnings.length > 0 && (
            <div style={{
              fontSize: '10.5px',
              lineHeight: 1.5,
              color: 'var(--win-warning, #d68a00)',
              background: 'var(--win-bg-window)',
              border: '1px solid var(--win-border)',
              borderRadius: '4px',
              padding: '6px 8px',
            }}>
              {viewWarnings.slice(0, 3).map((w) => (
                <div key={w.view}>
                  {t('exportDialog.warnViewDeps', { view: w.view, tables: w.missing.join(', ') })}
                </div>
              ))}
              {viewWarnings.length > 3 && (
                <div>{t('exportDialog.warnViewDepsMore', { n: viewWarnings.length - 3 })}</div>
              )}
            </div>
          )}

          <div style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            border: '1px solid var(--win-border)',
            borderRadius: '4px',
            background: 'var(--win-bg-window)',
            padding: '8px',
            display: 'flex',
            flexDirection: 'column',
            gap: '6px'
          }}>
            {tablesLoading ? (
              <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)' }}>{t('exportDialog.loadingTables')}</div>
            ) : shown.length === 0 ? (
              <div style={{ fontSize: '11px', color: 'var(--win-text-disabled)' }}>
                {objects.length === 0 ? t('exportDialog.noTables') : t('exportDialog.noTableMatch')}
              </div>
            ) : (
              groups.map((group) => (
                <React.Fragment key={group.kind}>
                  {/* Tiêu đề nhóm dính at đầu vùng cuộn: with sakila, 23 table đẩy routine and
                      trigger xuống tận đáy, not có tiêu đề thì tưatng chúng not is xuất. */}
                  <div style={{
                    position: 'sticky',
                    top: '-8px',
                    zIndex: 1,
                    background: 'var(--win-bg-window)',
                    padding: '4px 0 2px',
                    fontSize: '10px',
                    fontWeight: 700,
                    letterSpacing: '0.04em',
                    color: 'var(--win-text-secondary)',
                    borderBottom: '1px solid var(--win-border)',
                  }}>
                    {t(LABEL_KEY[group.kind])} · {group.items.length}
                  </div>
                  {group.items.map((obj) => {
                    const key = objKey(obj);
                    return (
                      <label key={key} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                        <input type="checkbox" checked={selected.includes(key)} onChange={() => toggleOne(key)} />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{obj.name}</span>
                        {/* Trigger đi theo table chủ -> nói rõ is table nào. */}
                        {obj.table && (
                          <span style={{ fontSize: '10px', color: 'var(--win-text-secondary)', flexShrink: 0 }}>
                            {t('exportDialog.triggerOn', { table: obj.table })}
                          </span>
                        )}
                      </label>
                    );
                  })}
                </React.Fragment>
              ))
            )}
          </div>
        </div>
      </div>

      <ModalFooter>
        {error ? (
          <span style={{ marginRight: 'auto', fontSize: '11px', color: 'var(--win-error, #ff6b6b)' }}>
            {error}
          </span>
        ) : null}
        <button className="btn btn-secondary" onClick={onClose} disabled={submitting} style={{ flexShrink: 0 }}>{t('common.cancel')}</button>
        <button
          className="btn btn-primary"
          onClick={submit}
          disabled={submitting || tablesLoading || selected.length === 0}
          style={{ background: 'var(--win-accent)', color: '#fff', border: 'none', flexShrink: 0 }}
        >
          {submitting ? t('exportDialog.exporting') : t('exportDialog.startExport')}
        </button>
      </ModalFooter>
    </Modal>
  );
};
