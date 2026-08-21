import React, { useState, useEffect, useRef } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { activeConnId, dbHelper, setActiveConnId } from '../utils/dbHelper';
import type { DbConnectionConfig } from '../utils/dbHelper';
import { Database, Server, CheckCircle2, AlertTriangle, Plus, Trash2, Save, Copy, Download, Upload, Lock, Key, TerminalSquare, Hash, FolderOpen, User, Link, Star, Eye, EyeOff, ShieldAlert, Search, X, ChevronDown, ChevronRight, RefreshCw, ShieldCheck, Network, ArrowLeft, Check, Cloud, DatabaseBackup, LogIn } from 'lucide-react';
import { PostgresIcon, MySqlIcon, RedisIcon, SqliteIcon } from './DbIcons';
import { encryptConnectionExport, decryptConnectionExport } from '../utils/cryptoHelper';
import { CONN_ENVS, envLabelKey, legacyEnvOfColor, normalizeEnv, type ConnEnv } from '../utils/connEnv';
import {
  parseDumpObjects,
  parseDumpTableNames,
  buildDropStatements,
  addExistsHint,
  dumpStatementObject,
  stripLeadingSqlComments,
  isSkippedDumpBody,
  commentOnlyFromBody,
} from '../utils/dumpPreview';
import { splitStatements } from '../sql/statements';
import { buildDump, dumpReaderFor } from '../utils/dumpBuilder';
import { gzipText, getLastExportDir, saveExportFile, pickOpenFile, pickSqliteDatabaseFile } from '../utils/fileSave';
import { fileBaseFromPath, fileStamp, safeFileBase } from '../utils/exportHelper';
import { ProgressBar, type ProgressState } from './ProgressBar';
import { ConfirmDialog } from './ConfirmDialog';

/**
 * Seconds -> "12 seconds" / "2 min 5 sec" for the restore ETA.
 * Takes `t` because it is module-level and cannot call the hook itself.
 */
function formatRestoreEta(t: TFunction, totalSeconds: number): string {
  const s = Math.max(1, Math.round(totalSeconds));
  if (s < 60) return t('connection.etaSeconds', { s });
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? t('connection.etaMinutesSeconds', { m, s: rest }) : t('connection.etaMinutes', { m });
  const h = Math.floor(m / 60);
  const restM = m % 60;
  return restM ? t('connection.etaHoursMinutes', { h, m: restM }) : t('connection.etaHours', { h });
}
import {
  SECRET_FIELDS,
  hasInlineSecrets,
  mergeSecrets,
  newProfileId,
  pickSecrets,
  publicConfig,
} from '../utils/secretFields';
import { TerminalPanel } from './TerminalPanel';

const PROFILES_KEY = 'tf_connection_profiles';
const SECRET_FIELD_LIST: string[] = [...SECRET_FIELDS];

const LoadingSpinner: React.FC<{ size?: number; style?: React.CSSProperties; className?: string }> = ({ size = 16, style, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={`loading-spinner ${className || ''}`}
    style={style}
  >
    <circle
      cx="12"
      cy="12"
      r="10"
      stroke="var(--win-border-strong, #383b44)"
      strokeWidth="3"
      opacity="0.2"
    />
    <path
      d="M12 2C6.47715 2 2 6.47715 2 12C2 13.5683 2.36155 15.0506 3.00769 16.3718"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
    />
  </svg>
);

// Nút hiện/ẩn mật khẩu nằm bên trong ô input.
const EyeBtn: React.FC<{ on: boolean; onClick: () => void }> = ({ on, onClick }) => {
  const { t } = useTranslation();
  return (
    <button type="button" className="cm-eye" onClick={onClick} title={on ? t('connection.hidePassword') : t('connection.showPassword')}>
      {on ? <EyeOff size={14} /> : <Eye size={14} />}
    </button>
  );
};

// Nút chọn tệp (chứng chỉ SSL, private key...) — chỉ hiện tên tệp cho gọn.
const FilePick: React.FC<{ id: string; value: string; label: string; onPick: (path: string) => void }> = ({ id, value, label, onPick }) => {
  const handleClick = async () => {
    const file = await pickOpenFile({ title: label });
    if (file) {
      onPick(file);
      return;
    }
    if (file === null) {
      // Fallback for non-Tauri / web mode
      document.getElementById(id)?.click();
    }
  };

  return (
    <>
      <input
        type="file"
        id={id}
        className="cm-hidden-file"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onPick((file as any).path || file.name);
        }}
      />
      <button type="button" className={`cm-file-btn ${value ? 'has-file' : ''}`} onClick={handleClick} title={value || label}>
        <FolderOpen size={12} />
        <span>{value ? value.split(/[\\/]/).pop() : label}</span>
      </button>
    </>
  );
};

export interface SavedProfile {
  id: string;
  name: string;
  type: 'sqlite' | 'postgres' | 'mysql' | 'redis';
  config: any;
  /** Nhãn màu, thuần trang trí. Môi trường nằm ở `env` — xem `utils/connEnv.ts`. */
  color?: string;
  /**
   * Môi trường. Vắng mặt ở profile lưu trước khi có trường này; được điền một lần lúc nạp, suy từ
   * `color` theo cách hiểu cũ (xem `migrateProfileEnvs`).
   */
  env?: ConnEnv;
  group?: string;
  isDefault?: boolean;
}

/**
 * Điền `env` cho những profile chưa có, theo đúng ý nghĩa mà màu từng mang.
 *
 * Trả về `null` khi không có gì phải đổi, để chỗ gọi khỏi ghi lại localStorage vô ích. Bỏ bước này
 * thì mọi kết nối đang được đánh dấu production mất dấu ngay ở lần nâng cấp, không một lời báo.
 */
function migrateProfileEnvs(list: SavedProfile[]): SavedProfile[] | null {
  if (list.every((p) => p.env !== undefined)) return null;
  return list.map((p) => (p.env === undefined ? { ...p, env: legacyEnvOfColor(p.color) } : p));
}

interface ConnectionManagerProps {
  /** Kết nối mà component này thao tác lên. Truyền tường minh, không đọc id ambient (§4.1). */
  connId: string;
  /**
   * Đang mount trong Modal "Thêm kết nối" (từ thanh tiêu đề), không phải làm màn hình đầu.
   *
   * Ẩn phần chrome thuộc *quản lý* kết nối chứ không thuộc việc *mở thêm một* kết nối: nhập/xuất tệp
   * profile, và Sao lưu & Phục hồi. Cái thứ hai đáng ẩn nhất — nó thao tác trên kết nối **đang mở**,
   * nên đặt nó trong hộp thoại "thêm kết nối" là mời người dùng backup một database khác với cái họ
   * đang nhìn.
   */
  embedded?: boolean;
  // `profile` là profile đã chọn để kết nối (nếu có). App giữ id + tên để popover
  // chi tiết kết nối sửa tên/màu rồi ghi thẳng ngược vào tf_connection_profiles.
  onConnect: (
    dbName: string,
    dbType: 'sqlite' | 'postgres' | 'mysql' | 'redis',
    color?: string,
    config?: DbConnectionConfig,
    // `env` sống ở đây chứ không thành tham số vị trí thứ bảy: nó là thuộc tính của profile, đúng
    // như `name`, và một kết nối không đến từ profile nào thì không có môi trường.
    profile?: { id: string; name: string; env?: ConnEnv },
    // Schema the backend actually landed in (Postgres `current_schema()`), null elsewhere.
    // Passed on rather than re-queried: it is part of the tab storage key, so App needs it
    // before it restores anything.
    schema?: string | null,
  ) => void;
}

// SSL levels in the order the <select> shows them. The explanation sits under
// the select instead of inside each <option> (a long option gets covered by the
// select arrow and the native popup overflows) — see sslModeDesc() below.
const SSL_MODES = ['DISABLED', 'PREFERRED', 'REQUIRED', 'VERIFY_CA', 'VERIFY_IDENTITY'] as const;
// Redis has no STARTTLS-style negotiation — a port either speaks TLS or it does not — so
// PREFERRED would be a mode that cannot be implemented honestly. `redis_ssl_mode` in
// redis_db.rs maps it to VERIFY_IDENTITY if an old profile still carries it.
const REDIS_SSL_MODES = ['DISABLED', 'REQUIRED', 'VERIFY_CA', 'VERIFY_IDENTITY'] as const;

// Logo thật của từng hệ DB (xem DbIcons.tsx) + màu thương hiệu cho ô nền.
const TYPE_META: Record<string, { label: string; color: string; Icon: React.FC<{ size?: number }> }> = {
  sqlite: { label: 'SQLite', color: '#003B57', Icon: SqliteIcon },
  postgres: { label: 'PostgreSQL', color: '#336791', Icon: PostgresIcon },
  mysql: { label: 'MySQL', color: '#00758F', Icon: MySqlIcon },
  redis: { label: 'Redis', color: '#DC382D', Icon: RedisIcon },
};

export const ConnectionManager: React.FC<ConnectionManagerProps> = ({ connId, embedded = false, onConnect }) => {
  const { t } = useTranslation();

  // A switch rather than t(`...${mode}`): a key built at runtime is not checked
  // against the key tree declared in i18next.d.ts.
  const sslModeDesc = (mode: string): string => {
    switch (mode) {
      case 'DISABLED': return t('connection.sslDescDisabled');
      case 'PREFERRED': return t('connection.sslDescPreferred');
      case 'REQUIRED': return t('connection.sslDescRequired');
      case 'VERIFY_CA': return t('connection.sslDescVerifyCa');
      case 'VERIFY_IDENTITY': return t('connection.sslDescVerifyIdentity');
      default: return '';
    }
  };

  // Labels for the status LED on each connection row in the sidebar.
  const ledTitle: Record<'busy' | 'ok' | 'fail', string> = {
    busy: t('connection.ledBusy'),
    ok: t('connection.ledOk'),
    fail: t('connection.ledFail'),
  };

  const [activeType, setActiveType] = useState<'sqlite' | 'postgres' | 'mysql' | 'redis' | 'backup_restore'>('sqlite');
  // Redis form state
  const [redisHost, setRedisHost] = useState('127.0.0.1');
  const [redisPort, setRedisPort] = useState(6379);
  const [redisUser, setRedisUser] = useState('');
  const [redisPassword, setRedisPassword] = useState('');
  const [redisDbIndex, setRedisDbIndex] = useState(0);
  const [showPw, setShowPw] = useState(false); // hiện/ẩn mật khẩu form kết nối
  const [profileSearch, setProfileSearch] = useState(''); // lọc profile ở sidebar
  const [testStatus, setTestStatus] = useState<'untested' | 'ok' | 'fail'>('untested'); // trạng thái Kiểm tra kết nối

  // Tab của form cấu hình: gom SSL / SSH ra tab riêng để form chính không bị dài.
  const [formTab, setFormTab] = useState<'general' | 'ssl' | 'ssh'>('general');
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({}); // nhóm đang thu gọn ở sidebar
  const [showNewMenu, setShowNewMenu] = useState(false); // menu chọn loại DB khi tạo kết nối mới
  const [showGroupList, setShowGroupList] = useState(false); // dropdown gợi ý nhóm đã có
  const [showDbList, setShowDbList] = useState(false); // dropdown chọn database đã tải về
  const [uriCopied, setUriCopied] = useState(false); // phản hồi sau khi copy connection string

  // Host được coi là "từ xa" (không phải local) -> dùng để cảnh báo SSL.
  const isRemoteHost = (h?: string) => {
    const v = (h || '').trim().toLowerCase();
    return v !== '' && !['localhost', '127.0.0.1', '::1', '0.0.0.0', 'host.docker.internal'].includes(v);
  };
  const [sqlitePath, setSqlitePath] = useState('');

  // PG config
  const [pgHost, setPgHost] = useState('localhost');
  const [pgPort, setPgPort] = useState(5432);
  const [pgUser, setPgUser] = useState('postgres');
  const [pgPassword, setPgPassword] = useState('');
  const [pgDatabase, setPgDatabase] = useState('postgres');

  // MySQL config
  const [myHost, setMyHost] = useState('localhost');
  const [myPort, setMyPort] = useState(3306);
  const [myUser, setMyUser] = useState('root');
  const [myPassword, setMyPassword] = useState('');
  const [myDatabase, setMyDatabase] = useState('');
  const [sslEnabled, setSslEnabled] = useState(false);
  // PREFERRED: dùng TLS nếu máy chủ hỗ trợ, tự lùi về không mã hoá nếu không —
  // nên không làm hỏng kết nối tới máy chủ nội bộ. Mặc định thật cho kết nối mới
  // nằm ở handleCreateNewProfile (config.sslMode), giá trị khởi tạo này chỉ phủ
  // nhịp render trước khi profile đầu tiên được chọn. Profile đã lưu không đổi:
  // hai chỗ nạp profile vẫn lùi về DISABLED cho bản ghi cũ chưa có trường này.
  const [sslMode, setSslMode] = useState('PREFERRED');
  const [sslKeyPath, setSslKeyPath] = useState('');
  const [sslCertPath, setSslCertPath] = useState('');
  const [sslCaPath, setSslCaPath] = useState('');

  // SSH config
  const [sshEnabled, setSshEnabled] = useState(false);
  const [sshHost, setSshHost] = useState('');
  const [sshPort, setSshPort] = useState(22);
  const [sshUser, setSshUser] = useState('');
  const [sshAuthType, setSshAuthType] = useState<'password' | 'key'>('password');
  const [sshPassword, setSshPassword] = useState('');
  const [sshKeyPath, setSshKeyPath] = useState('');
  const [sshKeyContent, setSshKeyContent] = useState('');
  const [sshPassphrase, setSshPassphrase] = useState('');

  // AWS IAM authentication (RDS/Aurora)
  const [authMethod, setAuthMethod] = useState<'password' | 'aws_iam'>('password');
  const [awsAuthType, setAwsAuthType] = useState<'access_key' | 'profile'>('access_key');
  const [awsAccessKeyId, setAwsAccessKeyId] = useState('');
  const [awsSecretAccessKey, setAwsSecretAccessKey] = useState('');
  const [awsSessionToken, setAwsSessionToken] = useState('');
  const [awsProfile, setAwsProfile] = useState('');
  const [awsRegion, setAwsRegion] = useState('');

  const [isConnecting, setIsConnecting] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const isBusy = isConnecting || isTesting;
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [isSuccessConnecting, setIsSuccessConnecting] = useState(false);
  const [connectingDbName, setConnectingDbName] = useState('');

  // Thông báo tự ẩn: thành công 4s, lỗi 8s (dài hơn để còn đọc kịp nội dung lỗi).
  // Thời gian này phải khớp với keyframes cmAlertLife / cmAlertLifeLong trong CSS.
  useEffect(() => {
    if (!successMsg) return;
    const timer = setTimeout(() => setSuccessMsg(null), 4000);
    return () => clearTimeout(timer);
  }, [successMsg]);

  useEffect(() => {
    if (!errorMsg) return;
    const timer = setTimeout(() => setErrorMsg(null), 8000);
    return () => clearTimeout(timer);
  }, [errorMsg]);

  // Connection-less Backup/Restore States
  const [brAction, setBrAction] = useState<'backup' | 'restore'>('backup');
  const [brType, setBrType] = useState<'sqlite' | 'postgres' | 'mysql'>('sqlite');
  const [brSqlitePath, setBrSqlitePath] = useState('');
  const [brPgHost, setBrPgHost] = useState('localhost');
  const [brPgPort, setBrPgPort] = useState(5432);
  const [brPgUser, setBrPgUser] = useState('postgres');
  const [brPgPassword, setBrPgPassword] = useState('');
  const [brPgDatabase, setBrPgDatabase] = useState('postgres');
  const [brMyHost, setBrMyHost] = useState('localhost');
  const [brMyPort, setBrMyPort] = useState(3306);
  const [brMyUser, setBrMyUser] = useState('root');
  const [brMyPassword, setBrMyPassword] = useState('');
  const [brMyDatabase, setBrMyDatabase] = useState('');

  // Tên tệp gợi ý là `bk_<database>_<thời điểm>`, nhưng người dùng gõ tay là dừng gợi ý
  // (`brFilenameTouched`) — không thì đổi database một cái là xoá mất tên họ vừa đặt.
  const [brFilename, setBrFilename] = useState('');
  const [brFilenameTouched, setBrFilenameTouched] = useState(false);
  // Dấu thời gian chốt MỘT lần lúc mở màn hình: tính lại theo từng lần render thì con số trong ô
  // nhảy liên tục trong lúc người dùng đang gõ máy chủ/database.
  const [brStamp, setBrStamp] = useState(() => fileStamp());
  const [brCompressGzip, setBrCompressGzip] = useState(false);
  const [brDropTable, setBrDropTable] = useState(true);
  const [brIncludeStructure, setBrIncludeStructure] = useState(true);
  const [brIncludeContent, setBrIncludeContent] = useState(true);
  const [brFile, setBrFile] = useState<File | null>(null);
  // Xoá đối tượng trùng tên trước khi chạy dump (nếu không sẽ lỗi "already exists")
  const [brOverwrite, setBrOverwrite] = useState(false);
  // Bỏ qua câu lệnh lỗi thay vì rollback toàn bộ — cùng nghĩa với ô ở popup Nhập.
  const [brContinueOnError, setBrContinueOnError] = useState(false);
  // Bản tóm tắt xác nhận + tiến độ thật của lần phục hồi
  const [brConfirm, setBrConfirm] = useState(false);
  const [brProgress, setBrProgress] = useState<ProgressState | null>(null);
  const [brLoading, setBrLoading] = useState(false);
  const [brParsedTables, setBrParsedTables] = useState<string[]>([]);
  const [brSelectedTables, setBrSelectedTables] = useState<string[]>([]);
  const [brParsing, setBrParsing] = useState(false);

  const [brSqlText, setBrSqlText] = useState<string>('');
  const [availableDatabases, setAvailableDatabases] = useState<string[]>([]);
  const [loadingDbs, setLoadingDbs] = useState(false);

  // Vào lại màn Sao lưu & Phục hồi thì gợi ý lại tên tệp với dấu thời gian mới.
  useEffect(() => {
    if (activeType !== 'backup_restore') return;
    setBrFilenameTouched(false);
    setBrStamp(fileStamp());
  }, [activeType]);

  /**
   * `bk_<database>_<20260821_143512>`: sắp được theo thời gian, và hai lần sao lưu liên tiếp
   * không ghi đè lên nhau. SQLite lấy tên tệp (không phần mở rộng) chứ không lấy cả đường dẫn —
   * `safeFileBase` sẽ biến `C:\data\demo.db` thành `C__data_demo.db`.
   */
  const brDbLabel = brType === 'sqlite'
    ? fileBaseFromPath(brSqlitePath)
    : brType === 'postgres' ? brPgDatabase : brMyDatabase;
  const brSuggestedFilename = `bk_${safeFileBase(brDbLabel)}_${brStamp}`;
  const brEffectiveFilename = brFilenameTouched ? brFilename : brSuggestedFilename;

  // Cấu hình SSL đang chọn ở form — phải gửi kèm mọi lệnh phụ (liệt kê database,
  // sao lưu/phục hồi), nếu không backend sẽ hiểu là DISABLED và tắt hẳn TLS.
  const currentSslConfig = () => ({
    sslEnabled,
    sslMode,
    sslKeyPath,
    sslCertPath,
    sslCaPath,
  });

  // Form Sao lưu & Phục hồi không có phần SSL riêng: lấy theo profile đã chọn,
  // không có profile thì để PREFERRED (dùng TLS nếu máy chủ hỗ trợ).
  const brSslConfig = () => {
    const prof = profiles.find(p => p.id === selectedBrProfileId);
    const c: any = prof?.config || {};
    return {
      sslEnabled: c.sslEnabled ?? false,
      sslMode: c.sslMode || 'PREFERRED',
      sslKeyPath: c.sslKeyPath || '',
      sslCertPath: c.sslCertPath || '',
      sslCaPath: c.sslCaPath || '',
    };
  };

  const fetchDatabases = async (type: 'postgres' | 'mysql' | 'br_mysql' | 'br_postgres') => {
    setLoadingDbs(true);
    setErrorMsg(null);
    let config: DbConnectionConfig;

    if (type === 'postgres') {
      config = {
        type: 'postgres',
        host: pgHost,
        port: pgPort,
        user: pgUser,
        password: pgPassword,
        database: pgDatabase,
        ...currentSslConfig(),
      };
    } else if (type === 'mysql') {
      config = {
        type: 'mysql',
        host: myHost,
        port: myPort,
        user: myUser,
        password: myPassword,
        database: myDatabase,
        ...currentSslConfig(),
      };
    } else if (type === 'br_postgres') {
      config = {
        type: 'postgres',
        host: brPgHost,
        port: brPgPort,
        user: brPgUser,
        password: brPgPassword,
        database: brPgDatabase,
        ...brSslConfig(),
      };
    } else {
      config = {
        type: 'mysql',
        host: brMyHost,
        port: brMyPort,
        user: brMyUser,
        password: brMyPassword,
        database: brMyDatabase,
        ...brSslConfig(),
      };
    }

    try {
      const res = await dbHelper.getDatabasesList(config);
      if (res.success && res.databases) {
        setAvailableDatabases(res.databases);
      } else {
        setErrorMsg(res.error || t('connection.errLoadDatabases'));
      }
    } catch (e: any) {
      setErrorMsg(e.toString());
    } finally {
      setLoadingDbs(false);
    }
  };

  // fetchDatabases được tạo lại mỗi render (nó đọc rất nhiều state). KHÔNG thể đưa
  // thẳng vào deps của 3 effect debounce bên dưới: effect sẽ chạy lại sau mỗi render,
  // timer 500ms bị reset liên tục và gần như không bao giờ nổ -> mất hẳn tính năng
  // tự tải danh sách database. Giữ bản mới nhất trong ref: ref là stable nên
  // exhaustive-deps không đòi, mà effect vẫn luôn gọi đúng bản mới nhất.
  const fetchDbRef = useRef(fetchDatabases);
  useEffect(() => { fetchDbRef.current = fetchDatabases; });

  // Auto-load databases for Postgres
  useEffect(() => {
    if (activeType !== 'postgres') return;
    if (!pgHost.trim() || !pgUser.trim()) return;

    const timer = setTimeout(() => {
      fetchDbRef.current('postgres');
    }, 500);

    return () => clearTimeout(timer);
  }, [pgHost, pgPort, pgUser, pgPassword, activeType]);

  // Auto-load databases for MySQL
  useEffect(() => {
    if (activeType !== 'mysql') return;
    if (!myHost.trim() || !myUser.trim()) return;

    const timer = setTimeout(() => {
      fetchDbRef.current('mysql');
    }, 500);

    return () => clearTimeout(timer);
  }, [myHost, myPort, myUser, myPassword, activeType]);

  // Auto-load databases for Backup & Restore
  useEffect(() => {
    if (activeType !== 'backup_restore') return;
    if (brType === 'sqlite') return;

    if (brType === 'postgres') {
      if (!brPgHost.trim() || !brPgUser.trim()) return;
      const timer = setTimeout(() => {
        fetchDbRef.current('br_postgres');
      }, 500);
      return () => clearTimeout(timer);
    } else {
      if (!brMyHost.trim() || !brMyUser.trim()) return;
      const timer = setTimeout(() => {
        fetchDbRef.current('br_mysql');
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [brType, brPgHost, brPgPort, brPgUser, brPgPassword, brMyHost, brMyPort, brMyUser, brMyPassword, activeType]);

  useEffect(() => {
    const parseTables = async () => {
      if (!brFile) {
        setBrParsedTables([]);
        setBrSelectedTables([]);
        setBrSqlText('');
        return;
      }
      setBrParsing(true);
      setErrorMsg(null);
      try {
        const reader = new FileReader();
        reader.onload = async (event) => {
          try {
            const text = event.target?.result as string;
            setBrSqlText(text);

            // Dùng chung bộ dò với popup Nhập: nó nhận cả VIEW (dump ghi view bằng
            // CREATE VIEW / DROP VIEW, không phải DROP TABLE) và loại bảng tạm trong routine.
            const tables = parseDumpTableNames(text);
            setBrParsedTables(tables);
            setBrSelectedTables(tables);
          } catch (e) {
            console.error(e);
          } finally {
            setBrParsing(false);
          }
        };
        reader.readAsText(brFile);
      } catch (err: any) {
        console.error('Lỗi đọc bảng từ file:', err);
        setBrParsing(false);
      }
    };
    parseTables();
  }, [brFile]);

  // Connection Profiles States
  const [profiles, setProfiles] = useState<SavedProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [defaultProfileId, setDefaultProfileId] = useState<string | null>(() => localStorage.getItem('tf_default_profile_id'));
  const [selectedBrProfileId, setSelectedBrProfileId] = useState<string | null>(null);
  const [profileNameInput, setProfileNameInput] = useState('');
  const [profileColor, setProfileColor] = useState('');
  const [profileEnv, setProfileEnv] = useState<ConnEnv>('none');
  const [profileGroup, setProfileGroup] = useState('');
  const [secretError, setSecretError] = useState<string | null>(null); // lỗi khi thao tác với kho bí mật HĐH

  // Điểm ghi profile DUY NHẤT: luôn bóc bí mật ra khỏi config trước khi chạm localStorage,
  // đồng thời đẩy bí mật sang kho bảo mật của HĐH. State trong bộ nhớ cũng giữ bản đã bóc
  // để không có đường nào vô tình serialize lại mật khẩu.
  const persistProfiles = async (list: SavedProfile[]): Promise<SavedProfile[]> => {
    const stripped: SavedProfile[] = [];
    const pending: Array<Promise<void>> = [];

    for (const p of list) {
      const values = pickSecrets(p.config);
      stripped.push({ ...p, config: publicConfig(p.config) });
      if (Object.keys(values).length > 0) pending.push(dbHelper.setSecrets(p.id, values));
    }

    setProfiles(stripped);
    localStorage.setItem(PROFILES_KEY, JSON.stringify(stripped));

    try {
      await Promise.all(pending);
      setSecretError(null);
    } catch (e: any) {
      // Cấu hình vẫn được lưu, chỉ riêng bí mật không vào được kho HĐH -> phải nói rõ.
      setSecretError(t('connection.errSaveSecrets', { message: e?.message || e }));
    }
    return stripped;
  };

  // Đọc lại bí mật của một profile từ kho HĐH và ghép vào config để đem đi dùng.
  const configWithSecrets = async (profile: SavedProfile): Promise<any> => {
    try {
      const secrets = await dbHelper.getSecrets(profile.id, SECRET_FIELD_LIST);
      return mergeSecrets(profile.config, secrets);
    } catch (e: any) {
      setSecretError(t('connection.errReadSecrets', { message: e?.message || e }));
      return profile.config;
    }
  };

  // Nhân bản bí mật sang một id khác, đi thẳng kho HĐH -> kho HĐH. Cố ý KHÔNG đọc bí mật
  // ra rồi gắn vào object profile: profile là thứ sẽ đi vào localStorage, cho bí mật chạy
  // qua nó là mở một đường (dù tạm thời) từ kho bảo mật ra bộ nhớ ghi xuống đĩa.
  const copySecretsBetweenProfiles = async (fromId: string, toId: string): Promise<void> => {
    try {
      const values = await dbHelper.getSecrets(fromId, SECRET_FIELD_LIST);
      if (Object.keys(values).length > 0) await dbHelper.setSecrets(toId, values);
      setSecretError(null);
    } catch (e: any) {
      setSecretError(t('connection.errCopySecrets', { message: e?.message || e }));
    }
  };

  const handleToggleDefaultProfile = (profileId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const nextId = defaultProfileId === profileId ? null : profileId;
    setDefaultProfileId(nextId);
    if (nextId) {
      localStorage.setItem('tf_default_profile_id', nextId);
    } else {
      localStorage.removeItem('tf_default_profile_id');
    }
  };

  const [showImportUrlModal, setShowImportUrlModal] = useState(false);
  const [importUrlInput, setImportUrlInput] = useState('');

  // Export & Import Connections States
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportScope, setExportScope] = useState<'all' | 'group' | 'single'>('all');
  const [exportGroupTarget, setExportGroupTarget] = useState<string>('');
  const [exportSingleProfile, setExportSingleProfile] = useState<SavedProfile | null>(null);
  const [exportIncludePasswords, setExportIncludePasswords] = useState(false);
  const [exportFilePassword, setExportFilePassword] = useState('');
  const [exporting, setExporting] = useState(false);

  const [showImportPasswordModal, setShowImportPasswordModal] = useState(false);
  const [pendingImportContent, setPendingImportContent] = useState<string | null>(null);
  const [importPasswordInput, setImportPasswordInput] = useState('');
  const [importing, setImporting] = useState(false);

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    scope: 'all' | 'group' | 'single';
    groupName?: string;
    profile?: SavedProfile;
  } | null>(null);

  // Profile đang mở Terminal (null = không mở). Có SSH -> SSH terminal; không -> shell cục bộ.
  const [terminalProfile, setTerminalProfile] = useState<SavedProfile | null>(null);

  // Two confirmations replacing window.confirm (which shows nothing in the Tauri webview).
  const [deleteProfileId, setDeleteProfileId] = useState<string | null>(null);
  const [confirmPlainExport, setConfirmPlainExport] = useState(false);

  const openExportModal = (scope: 'all' | 'group' | 'single', groupName?: string, profile?: SavedProfile) => {
    setExportScope(scope);
    setExportGroupTarget(groupName || '');
    setExportSingleProfile(profile || null);
    setExportIncludePasswords(false);
    setExportFilePassword('');
    setShowExportModal(true);
    setContextMenu(null);
  };

  /**
   * `plainConfirmed` = the "passwords in the clear" warning has already been answered.
   *
   * The warning used to be a `window.confirm()` in the middle of this function, which shows
   * nothing inside the Tauri webview (the dialog plugin has no `confirm` command) — the
   * export then continued as if the user had agreed. It is now asked BEFORE any work, so
   * cancelling also means no secret is read out of the OS keychain.
   */
  const handlePerformExport = async (plainConfirmed = false) => {
    if (exportIncludePasswords && !exportFilePassword.trim() && !plainConfirmed) {
      setConfirmPlainExport(true);
      return;
    }
    setExporting(true);
    try {
      let targetProfiles: SavedProfile[] = [];
      if (exportScope === 'all') {
        targetProfiles = [...profiles];
      } else if (exportScope === 'group') {
        targetProfiles = profiles.filter(p => (p.group?.trim() || t('connection.defaultGroup')) === exportGroupTarget);
      } else if (exportScope === 'single' && exportSingleProfile) {
        targetProfiles = [exportSingleProfile];
      }

      if (targetProfiles.length === 0) {
        alert(t('connection.errNoProfilesToExport'));
        setExporting(false);
        return;
      }

      // profiles trong bộ nhớ đã không còn bí mật -> muốn xuất kèm mật khẩu thì phải
      // đọc lại từ kho bảo mật của HĐH. Không kèm thì giữ nguyên bản đã bóc.
      const processedProfiles = await Promise.all(
        targetProfiles.map(async p => {
          const cloned = JSON.parse(JSON.stringify(p));
          cloned.config = exportIncludePasswords ? await configWithSecrets(p) : publicConfig(cloned.config);
          return cloned;
        })
      );

      const encryptedText = await encryptConnectionExport(processedProfiles, exportFilePassword);

      const blob = new Blob([encryptedText], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const filenameStr = exportScope === 'group' ? `TablePlus_${exportGroupTarget.replace(/[^a-zA-Z0-9]/g, '_')}_Connections.tableplusconnection` :
        exportScope === 'single' ? `TablePlus_${exportSingleProfile?.name.replace(/[^a-zA-Z0-9]/g, '_')}_Connection.tableplusconnection` :
          'TablePlus_All_Connections.tableplusconnection';
      a.download = filenameStr;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setShowExportModal(false);
      setSuccessMsg(t('connection.exportSuccess', { n: processedProfiles.length }));
    } catch (e: any) {
      alert(t('connection.errExport', { message: e.message }));
    } finally {
      setExporting(false);
    }
  };

  const handleFileImportSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (evt) => {
      const content = evt.target?.result as string;
      if (!content) return;

      try {
        await processImportContent(content);
      } catch (err: any) {
        if (err.requiresPassword) {
          setPendingImportContent(content);
          setImportPasswordInput('');
          setShowImportPasswordModal(true);
        } else {
          alert(t('connection.errImport', { message: err.message }));
        }
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const processImportContent = async (content: string, password?: string) => {
    setImporting(true);
    try {
      const importedData = await decryptConnectionExport(content, password);
      let newProfilesToImport: SavedProfile[] = [];

      if (Array.isArray(importedData)) {
        newProfilesToImport = importedData;
      } else if (importedData && typeof importedData === 'object') {
        if (Array.isArray(importedData.profiles)) {
          newProfilesToImport = importedData.profiles;
        } else if (importedData.id && importedData.type && importedData.config) {
          newProfilesToImport = [importedData as SavedProfile];
        }
      }

      if (newProfilesToImport.length === 0) {
        throw new Error(t('connection.errImportInvalid'));
      }

      // Merge into existing profiles without duplicate IDs
      const existingIds = new Set(profiles.map(p => p.id));
      const merged = [...profiles];
      let importedCount = 0;

      for (const item of newProfilesToImport) {
        if (!item.name || !item.type || !item.config) continue;
        let itemToSave = { ...item };
        if (existingIds.has(itemToSave.id)) {
          itemToSave.id = newProfileId();
        }
        merged.push(itemToSave);
        existingIds.add(itemToSave.id);
        importedCount++;
      }

      // Tệp import có thể chứa mật khẩu dạng thô -> persistProfiles đẩy chúng sang kho HĐH
      // và chỉ ghi phần cấu hình sạch xuống localStorage.
      await persistProfiles(merged);
      setShowImportPasswordModal(false);
      setPendingImportContent(null);
      setSuccessMsg(t('connection.importSuccess', { n: importedCount }));
    } catch (e: any) {
      if (e.requiresPassword) {
        throw e;
      }
      alert(t('connection.errImport', { message: e.message }));
    } finally {
      setImporting(false);
    }
  };

  const handlePasswordDecryptSubmit = async () => {
    if (!pendingImportContent) return;
    try {
      await processImportContent(pendingImportContent, importPasswordInput);
    } catch (err: any) {
      if (!err.requiresPassword) {
        alert(t('connection.errDecrypt', { message: err.message }));
      }
    }
  };

  const parseConnectionUrl = (urlStr: string) => {
    try {
      const cleanUrl = urlStr.trim();
      if (!cleanUrl) return null;

      if (cleanUrl.startsWith('sqlite://')) {
        const path = cleanUrl.replace('sqlite://', '');
        return {
          type: 'sqlite' as const,
          config: { type: 'sqlite', sqlitePath: path }
        };
      }

      let protocol: 'postgres' | 'mysql' = 'postgres';
      if (cleanUrl.startsWith('postgres://') || cleanUrl.startsWith('postgresql://')) {
        protocol = 'postgres';
      } else if (cleanUrl.startsWith('mysql://')) {
        protocol = 'mysql';
      } else {
        throw new Error(t('connection.errUrlProtocol'));
      }

      // Parse URL
      const urlToParse = cleanUrl.replace(/^(postgres|postgresql|mysql):\/\//, 'http://');
      const parsed = new URL(urlToParse);

      const host = parsed.hostname || 'localhost';
      const port = parsed.port ? parseInt(parsed.port) : (protocol === 'postgres' ? 5432 : 3306);
      const user = decodeURIComponent(parsed.username || (protocol === 'postgres' ? 'postgres' : 'root'));
      const password = decodeURIComponent(parsed.password || '');
      let database = parsed.pathname ? parsed.pathname.substring(1) : '';
      if (database.includes('?')) {
        database = database.split('?')[0];
      }
      database = decodeURIComponent(database);

      return {
        type: protocol,
        config: {
          type: protocol,
          host,
          port,
          user,
          password,
          database: database || (protocol === 'postgres' ? 'postgres' : '')
        }
      };
    } catch (e: any) {
      alert(t('connection.errUrlFormat', { message: e.message }));
      return null;
    }
  };

  const handleImportUrlSubmit = async () => {
    const res = parseConnectionUrl(importUrlInput);
    if (!res) return;

    const newProfile: SavedProfile = {
      id: newProfileId(),
      name: `Imported ${res.type.toUpperCase()} (${res.config.host || res.config.sqlitePath || 'DB'})`,
      type: res.type,
      config: res.config
    };

    // URL kết nối thường có sẵn mật khẩu -> tách sang kho HĐH ngay khi lưu.
    await persistProfiles([...profiles, newProfile]);
    selectProfile(newProfile);

    setShowImportUrlModal(false);
    setImportUrlInput('');
    setSuccessMsg(t('connection.importUrlSuccess'));
  };


  // Load saved connection configurations from localStorage
  useEffect(() => {
    const saved = localStorage.getItem(PROFILES_KEY);
    const savedDefaultId = localStorage.getItem('tf_default_profile_id');
    if (saved) {
      try {
        const raw: SavedProfile[] = JSON.parse(saved);
        // Di trú bản cũ #2: môi trường từng được suy từ màu. Điền `env` một lần rồi ghi xuống, để
        // từ đây màu chỉ còn là màu.
        const migrated = migrateProfileEnvs(raw);
        const parsed = migrated ?? raw;
        // Di trú bản cũ: profile lưu trước đây còn mật khẩu nằm thẳng trong localStorage.
        // Đẩy chúng sang kho bảo mật của HĐH rồi ghi đè lại bản đã bóc sạch.
        if (migrated || parsed.some(p => hasInlineSecrets(p.config))) {
          persistProfiles(parsed);
        } else {
          setProfiles(parsed);
        }
        if (parsed.length > 0) {
          const defaultProf = parsed.find(p => p.id === savedDefaultId) || parsed[0];
          selectProfile(defaultProf);
        }
      } catch { }
    } else {
      setProfiles([]);
      localStorage.setItem(PROFILES_KEY, JSON.stringify([]));
    }
    // Mount-only bootstrap. persistProfiles/selectProfile now close over `t`,
    // whose identity changes on every language switch, so listing them here
    // would reload the profiles and wipe a half-filled form on each switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Điền form từ một profile. Bí mật không nằm trong profile.config nữa nên phải đọc
  // từ kho HĐH -> hàm này bất đồng bộ; phần không nhạy cảm hiện ra ngay, ô mật khẩu
  // được điền ngay sau đó.
  const selectProfile = async (profile: SavedProfile) => {
    setActiveProfileId(profile.id);
    setActiveType(profile.type);
    setTestStatus('untested');
    setFormTab('general');
    setErrorMsg(null);
    setSuccessMsg(null);
    setProfileNameInput(profile.name);
    setProfileColor(profile.color || '');
    // `normalizeEnv` chứ không phải `profile.env ?? 'none'`: profile có thể đến từ tệp export của
    // bản khác, và một chuỗi lạ lọt vào đây sẽ làm ô chọn không khớp lựa chọn nào.
    setProfileEnv(normalizeEnv(profile.env));
    setProfileGroup(profile.group || '');

    const config = await configWithSecrets(profile);
    if (profile.type === 'sqlite') {
      setSqlitePath(config.sqlitePath || '');
    } else if (profile.type === 'redis') {
      setRedisHost(config.host || '127.0.0.1');
      setRedisPort(config.port || 6379);
      setRedisUser(config.user || '');
      setRedisPassword(config.password || '');
      setRedisDbIndex(config.dbIndex ?? 0);
      setSslEnabled(config.sslEnabled || false);
      // Profile lưu trước khi có tab SSL chỉ có công tắc, và công tắc đó nghĩa là rediss://
      // với kiểm tra chứng chỉ đầy đủ -> VERIFY_IDENTITY, không phải mức yếu nhất.
      setSslMode(config.sslMode || (config.sslEnabled ? 'VERIFY_IDENTITY' : 'DISABLED'));
      setSslKeyPath(config.sslKeyPath || '');
      setSslCertPath(config.sslCertPath || '');
      setSslCaPath(config.sslCaPath || '');
      setSshEnabled(config.sshEnabled || false);
      setSshHost(config.sshHost || '');
      setSshPort(config.sshPort || 22);
      setSshUser(config.sshUser || '');
      setSshAuthType(config.sshAuthType || 'password');
      setSshPassword(config.sshPassword || '');
      setSshKeyPath(config.sshKeyPath || '');
      setSshKeyContent(config.sshKeyContent || '');
      setSshPassphrase(config.sshPassphrase || '');
    } else if (profile.type === 'postgres') {
      setPgHost(config.host || 'localhost');
      setPgPort(config.port || 5432);
      setPgUser(config.user || 'postgres');
      setPgPassword(config.password || '');
      setPgDatabase(config.database || 'postgres');
      setSslEnabled(config.sslEnabled || false);
      setSslMode(config.sslMode || (config.sslEnabled ? 'PREFERRED' : 'DISABLED'));
      setSslKeyPath(config.sslKeyPath || '');
      setSslCertPath(config.sslCertPath || '');
      setSslCaPath(config.sslCaPath || '');
      setSshEnabled(config.sshEnabled || false);
      setSshHost(config.sshHost || '');
      setSshPort(config.sshPort || 22);
      setSshUser(config.sshUser || '');
      setSshAuthType(config.sshAuthType || 'password');
      setSshPassword(config.sshPassword || '');
      setSshKeyPath(config.sshKeyPath || '');
      setSshKeyContent(config.sshKeyContent || '');
      setSshPassphrase(config.sshPassphrase || '');
      setAuthMethod(config.authMethod || 'password');
      setAwsAuthType(config.awsAuthType || 'access_key');
      setAwsAccessKeyId(config.awsAccessKeyId || '');
      setAwsSecretAccessKey(config.awsSecretAccessKey || '');
      setAwsSessionToken(config.awsSessionToken || '');
      setAwsProfile(config.awsProfile || '');
      setAwsRegion(config.awsRegion || '');
    } else if (profile.type === 'mysql') {
      setMyHost(config.host || 'localhost');
      setMyPort(config.port || 3306);
      setMyUser(config.user || 'root');
      setMyPassword(config.password || '');
      setMyDatabase(config.database || '');
      setSslEnabled(config.sslEnabled || false);
      setSslMode(config.sslMode || (config.sslEnabled ? 'PREFERRED' : 'DISABLED'));
      setSslKeyPath(config.sslKeyPath || '');
      setSslCertPath(config.sslCertPath || '');
      setSslCaPath(config.sslCaPath || '');
      setSshEnabled(config.sshEnabled || false);
      setSshHost(config.sshHost || '');
      setSshPort(config.sshPort || 22);
      setSshUser(config.sshUser || '');
      setSshAuthType(config.sshAuthType || 'password');
      setSshPassword(config.sshPassword || '');
      setSshKeyPath(config.sshKeyPath || '');
      setSshKeyContent(config.sshKeyContent || '');
      setSshPassphrase(config.sshPassphrase || '');
      setAuthMethod(config.authMethod || 'password');
      setAwsAuthType(config.awsAuthType || 'access_key');
      setAwsAccessKeyId(config.awsAccessKeyId || '');
      setAwsSecretAccessKey(config.awsSecretAccessKey || '');
      setAwsSessionToken(config.awsSessionToken || '');
      setAwsProfile(config.awsProfile || '');
      setAwsRegion(config.awsRegion || '');
    }
  };

  // Ba chỗ cần đúng cùng một payload Redis (lưu profile, kết nối, test kết nối). Trước đây
  // mỗi chỗ dựng riêng và nhánh lưu profile thì thiếu hẳn — profile Redis lưu ra config rỗng.
  const buildRedisConfig = (): DbConnectionConfig => ({
    type: 'redis',
    host: redisHost,
    port: redisPort,
    user: redisUser,
    password: redisPassword,
    dbIndex: redisDbIndex,
    sslEnabled,
    sslMode,
    sslKeyPath,
    sslCertPath,
    sslCaPath,
    sshEnabled,
    sshHost,
    sshPort,
    sshUser,
    sshAuthType,
    sshPassword,
    sshKeyPath,
    sshKeyContent,
    sshPassphrase,
  });

  const handleSaveProfile = async () => {
    if (!activeProfileId) return;
    const targetName = profileNameInput.trim() || t('connection.defaultProfileName');

    let config: any = {};
    if (activeType === 'sqlite') {
      config = { type: 'sqlite', sqlitePath };
    } else if (activeType === 'redis') {
      config = buildRedisConfig();
    } else if (activeType === 'postgres') {
      config = {
        type: 'postgres',
        host: pgHost,
        port: pgPort,
        user: pgUser,
        password: pgPassword,
        database: pgDatabase,
        sslEnabled,
        sslMode,
        sslKeyPath,
        sslCertPath,
        sslCaPath,
        sshEnabled,
        sshHost,
        sshPort,
        sshUser,
        sshAuthType,
        sshPassword,
        sshKeyPath,
        sshKeyContent,
        sshPassphrase,
        authMethod,
        awsAuthType,
        awsAccessKeyId,
        awsSecretAccessKey,
        awsSessionToken,
        awsProfile,
        awsRegion
      };
    } else if (activeType === 'mysql') {
      config = {
        type: 'mysql',
        host: myHost,
        port: myPort,
        user: myUser,
        password: myPassword,
        database: myDatabase,
        sslEnabled,
        sslMode,
        sslKeyPath,
        sslCertPath,
        sslCaPath,
        sshEnabled,
        sshHost,
        sshPort,
        sshUser,
        sshAuthType,
        sshPassword,
        sshKeyPath,
        sshKeyContent,
        sshPassphrase,
        authMethod,
        awsAuthType,
        awsAccessKeyId,
        awsSecretAccessKey,
        awsSessionToken,
        awsProfile,
        awsRegion
      };
    }

    const updatedProfiles = profiles.map(p => {
      if (p.id === activeProfileId) {
        return { ...p, name: targetName, type: activeType as any, config, color: profileColor, env: profileEnv, group: profileGroup };
      }
      return p;
    });

    // config lấy từ form nên có mật khẩu; persistProfiles tách ra kho HĐH trước khi ghi.
    await persistProfiles(updatedProfiles);
    setSuccessMsg(t('connection.saveSuccess'));
  };

  const handleCreateNewProfile = async (type: 'sqlite' | 'postgres' | 'mysql' | 'redis') => {
    // sslMode phải nằm sẵn trong config chứ không chỉ ở giá trị khởi tạo của
    // state: selectProfile ngay bên dưới đọc lại từ config, thiếu trường này là
    // nó lùi về DISABLED và ghi đè mọi thứ form đang hiển thị.
    const newProfile: SavedProfile = {
      id: newProfileId(),
      name: t('connection.newProfileName', { type: type.toUpperCase() }),
      type,
      config: type === 'sqlite'
        ? { type, sqlitePath: 'new_database.db' }
        : type === 'postgres'
          ? { type, host: 'localhost', port: 5432, user: 'postgres', database: 'postgres', sslMode: 'PREFERRED' }
          : type === 'redis'
            ? { type, host: '127.0.0.1', port: 6379, user: '', password: '', dbIndex: 0 }
            : { type, host: 'localhost', port: 3306, user: 'root', database: '', sslMode: 'PREFERRED' }
    };

    await persistProfiles([...profiles, newProfile]);
    selectProfile(newProfile);
  };

  const handleDeleteProfile = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteProfileId(id);
  };

  const doDeleteProfile = async (id: string) => {
    const newProfiles = profiles.filter(p => p.id !== id);
    await persistProfiles(newProfiles);
    // Dọn luôn bí mật trong kho HĐH, đừng để lại mục mồ côi.
    try {
      await dbHelper.deleteSecrets(id, SECRET_FIELD_LIST);
    } catch (err: any) {
      setSecretError(t('connection.errDeleteSecrets', { message: err?.message || err }));
    }

    if (activeProfileId === id) {
      if (newProfiles.length > 0) {
        selectProfile(newProfiles[0]);
      } else {
        setActiveProfileId(null);
      }
    }
  };

  const handleDuplicateProfile = async (profile: SavedProfile, e: React.MouseEvent) => {
    e.stopPropagation();
    // Bản sao phải mang theo cả bí mật, nhưng bí mật được nhân bản riêng trong kho HĐH
    // (xem copySecretsBetweenProfiles) chứ không đi kèm trong `duplicated.config`.
    const duplicated: SavedProfile = {
      ...profile,
      id: newProfileId(),
      name: `${profile.name} (Copy)`,
      config: publicConfig(profile.config)
    };
    await persistProfiles([...profiles, duplicated]);
    // Phải xong trước selectProfile: hàm đó đọc bí mật theo id mới để điền form.
    await copySecretsBetweenProfiles(profile.id, duplicated.id);
    selectProfile(duplicated);
  };

  const handleConnect = async (_isDemo = false) => {
    setIsConnecting(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    let config: DbConnectionConfig;

    if (activeType === 'sqlite') {
      config = { type: 'sqlite', sqlitePath };
    } else if (activeType === 'postgres') {
      config = {
        type: 'postgres',
        host: pgHost,
        port: pgPort,
        user: pgUser,
        password: pgPassword,
        database: pgDatabase,
        sslEnabled,
        sslMode,
        sslKeyPath,
        sslCertPath,
        sslCaPath,
        sshEnabled,
        sshHost,
        sshPort,
        sshUser,
        sshAuthType,
        sshPassword,
        sshKeyPath,
        sshKeyContent,
        sshPassphrase,
        authMethod,
        awsAuthType,
        awsAccessKeyId,
        awsSecretAccessKey,
        awsSessionToken,
        awsProfile,
        awsRegion
      };
      // Đã bỏ các cache 'tf_pg_config' / 'tf_ssh_config' ở đây: không chỗ nào đọc lại chúng,
      // riêng 'tf_ssh_config' còn ghi thẳng sshKeyContent (private key) + sshPassphrase xuống
      // localStorage dạng thô. Cấu hình kết nối chỉ còn sống trong profile (localStorage đã
      // bóc bí mật) và bí mật thì nằm trong kho bảo mật của HĐH (dbHelper.setSecrets).
    } else if (activeType === 'redis') {
      config = buildRedisConfig();
    } else {
      config = {
        type: 'mysql',
        host: myHost,
        port: myPort,
        user: myUser,
        password: myPassword,
        database: myDatabase,
        sslEnabled,
        sslMode,
        sslKeyPath,
        sslCertPath,
        sslCaPath,
        sshEnabled,
        sshHost,
        sshPort,
        sshUser,
        sshAuthType,
        sshPassword,
        sshKeyPath,
        sshKeyContent,
        sshPassphrase,
        authMethod,
        awsAuthType,
        awsAccessKeyId,
        awsSecretAccessKey,
        awsSessionToken,
        awsProfile,
        awsRegion
      };
      // Xem ghi chú ở nhánh postgres: các cache 'tf_my_config' / 'tf_ssh_config' đã bị bỏ.
    }

    // 'tf_last_type' cũng đã bỏ: ghi xuống nhưng không nơi nào đọc.

    const res = await dbHelper.connect(config);

    setIsConnecting(false);
    if (res.success) {
      setSuccessMsg(res.message);
      setIsSuccessConnecting(true);
      setConnectingDbName(res.database || (config.type === 'sqlite' ? config.sqlitePath : config.database) || 'Database');
      const activeProfile = profiles.find(p => p.id === activeProfileId);
      // Môi trường lấy từ STATE CỦA FORM, không từ profile đã lưu.
      //
      // `config` ngay bên trên cũng dựng từ form: host, port, user, SSL... đều đi thẳng vào lần kết
      // nối này dù người dùng chưa bấm Lưu. Riêng `env` mà đọc từ bản đã lưu thì ô chọn hiện
      // "Production" nhưng kết nối lại mở theo giá trị cũ — chỗ hụt tệ nhất có thể có cho một cờ an
      // toàn, vì thứ đang hiển thị và thứ đang có hiệu lực không còn là một. Lưu vẫn là việc riêng:
      // nó quyết định lần sau có nhớ hay không, chứ không quyết định lần này.
      const env = profileEnv;
      setTimeout(() => {
        onConnect(
          res.database || 'Database',
          config.type,
          activeProfile?.color,
          config,
          // Kết nối dựng tay (chưa lưu thành profile) vẫn phải nhận được môi trường vừa chọn: không
          // có chỗ để nhớ nó không có nghĩa là phiên này được phép bỏ qua nó.
          activeProfile || env !== 'none'
            ? { id: activeProfile?.id ?? '', name: activeProfile?.name ?? '', env }
            : undefined,
          res.schema,
        );
      }, 480);
    } else {
      setErrorMsg(res.message);
    }
  };

  const handleTestConnection = async () => {
    setIsTesting(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    // Redis: test bằng chính redis_connect (PING) qua dbHelper.connect.
    if (activeType === 'redis') {
      const res = await dbHelper.connect(buildRedisConfig());
      setIsTesting(false);
      setTestStatus(res.success ? 'ok' : 'fail');
      if (res.success) setSuccessMsg(t('connection.redisTestOk'));
      else setErrorMsg(res.message);
      // Ngắt kết nối test để không giữ phiên.
      await dbHelper.redisDisconnect();
      return;
    }

    let config: DbConnectionConfig;
    if (activeType === 'sqlite') {
      config = { type: 'sqlite', sqlitePath };
    } else if (activeType === 'postgres') {
      config = {
        type: 'postgres',
        host: pgHost,
        port: pgPort,
        user: pgUser,
        password: pgPassword,
        database: pgDatabase,
        sslEnabled,
        sslMode,
        sslKeyPath,
        sslCertPath,
        sslCaPath,
        sshEnabled,
        sshHost,
        sshPort,
        sshUser,
        sshAuthType,
        sshPassword,
        sshKeyPath,
        sshKeyContent,
        sshPassphrase,
        authMethod,
        awsAuthType,
        awsAccessKeyId,
        awsSecretAccessKey,
        awsSessionToken,
        awsProfile,
        awsRegion
      };
    } else {
      config = {
        type: 'mysql',
        host: myHost,
        port: myPort,
        user: myUser,
        password: myPassword,
        database: myDatabase,
        sslEnabled,
        sslMode,
        sslKeyPath,
        sslCertPath,
        sslCaPath,
        sshEnabled,
        sshHost,
        sshPort,
        sshUser,
        sshAuthType,
        sshPassword,
        sshKeyPath,
        sshKeyContent,
        sshPassphrase,
        authMethod,
        awsAuthType,
        awsAccessKeyId,
        awsSecretAccessKey,
        awsSessionToken,
        awsProfile,
        awsRegion
      };
    }

    const res = await dbHelper.connect(config);
    setIsTesting(false);
    setTestStatus(res.success ? 'ok' : 'fail');
    if (res.success) {
      setSuccessMsg(t('connection.testOk'));
      await dbHelper.disconnect();
    } else {
      setErrorMsg(res.message);
    }
  };

  // Bấm "Bắt đầu phục hồi" -> hiện bản tóm tắt (database đích, số bảng, số câu lệnh, ước tính)
  // rồi mới chạy; nhánh sao lưu thì chạy luôn.
  const handleBrClick = (e: React.MouseEvent) => {
    e.preventDefault();
    if (brAction === 'restore') {
      setBrConfirm(true);
      return;
    }
    handleBrSubmit();
  };

  const handleBrSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setBrConfirm(false);
    setBrLoading(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    let config: DbConnectionConfig;
    if (brType === 'sqlite') {
      config = { type: 'sqlite', sqlitePath: brSqlitePath };
    } else if (brType === 'postgres') {
      config = {
        type: 'postgres',
        host: brPgHost,
        port: brPgPort,
        user: brPgUser,
        password: brPgPassword,
        database: brPgDatabase,
        ...brSslConfig(),
      };
    } else {
      config = {
        type: 'mysql',
        host: brMyHost,
        port: brMyPort,
        user: brMyUser,
        password: brMyPassword,
        database: brMyDatabase,
        ...brSslConfig(),
      };
    }

    // Màn này mở kết nối RIÊNG của nó, nên mọi lệnh phải mang đúng id vừa mint — không phải
    // `connId` của workspace (prop). Khi chưa kết nối gì, prop là chuỗi rỗng và `getTables` trả
    // mảng rỗng, tức là báo "database không có bảng nào"; khi đang có kết nối, nó trỏ vào
    // database KHÁC và bản sao lưu là của database đó. `prevConnId` được trả lại ở `finally`
    // vì `connect()` đổi luôn kết nối active của cả app.
    const prevConnId = activeConnId();
    let brConnId = '';
    try {
      const connRes = await dbHelper.connect(config);
      if (!connRes.success) {
        throw new Error(t('connection.errConnectFailed', { message: connRes.message }));
      }
      brConnId = connRes.connId || activeConnId();

      if (brAction === 'backup') {
        // Dump dựng bằng đúng code của popup "Xuất Cơ sở dữ liệu" (buildDump): trước đây chỗ
        // này gọi lệnh Rust `export_multi_tables`, vốn coi view là bảng (sinh DROP TABLE và
        // INSERT INTO cho view), ghi một INSERT cho mỗi dòng, và không hề có routine/trigger.
        const list = await dbHelper.getTables(brConnId);
        const tables = list.map(item => item.name);
        if (tables.length === 0) {
          throw new Error(t('connection.errNoTablesToBackup'));
        }
        const [dbObjs, triggers] = await Promise.all([
          dbHelper.getDatabaseObjects(brConnId),
          dbHelper.getAllTriggers(),
        ]);

        const sqlText = await buildDump({
          dbType: config.type,
          tables,
          views: list.filter(item => item.type === 'view').map(item => item.name),
          routines: [
            ...dbObjs.functions.map((name) => ({ name, kind: 'function' as const })),
            ...dbObjs.procedures.map((name) => ({ name, kind: 'procedure' as const })),
          ],
          triggers: triggers.map((tr) => tr.name),
          events: dbObjs.events,
          sqlOptions: {
            dropTable: brDropTable,
            includeStructure: brIncludeStructure,
            includeContent: brIncludeContent,
          },
          // Schema mà `connect` vừa báo là đang dùng — cùng schema mà getTables() ở trên đọc ra.
          // Không có ô chọn schema ở màn hình này, nên đây luôn là schema đầu search_path.
          schema: connRes.schema,
          onProgress: setBrProgress,
        }, dumpReaderFor(dbHelper, brConnId));

        const base = brEffectiveFilename.trim().replace(/\.(sql|sql\.gz|gz)$/i, '') || brSuggestedFilename;
        const fileName = base + (brCompressGzip ? '.sql.gz' : '.sql');
        setBrProgress({ label: t('app.exportWriting') });
        const payload = brCompressGzip ? await gzipText(sqlText) : sqlText;
        const saved = await saveExportFile(
          getLastExportDir() || null,
          fileName,
          payload,
          brCompressGzip ? 'application/gzip' : 'text/plain;charset=utf-8'
        );
        setBrProgress(null);
        setSuccessMsg(`${t('connection.backupSuccess')} — ${saved.path || fileName}`);
      } else {
        if (!brFile || !brSqlText) {
          throw new Error(t('connection.errNoBackupFile'));
        }

        // Ghi đè: chèn DROP ... IF EXISTS lên đầu, và cho các tên đó qua bộ lọc theo bảng
        // của backend (nó chỉ chạy câu lệnh có nhắc tên trong danh sách truyền vào).
        const objs = brOverwrite ? parseDumpObjects(brSqlText) : null;
        const drops = brOverwrite ? brDropStatements : [];
        const sqlToRun = drops.length ? `${drops.join('\n')}\n${brSqlText}` : brSqlText;
        const tablesToRun = objs
          ? [...new Set([...brSelectedTables, ...objs.views, ...objs.triggers, ...objs.procedures, ...objs.functions])]
          : brSelectedTables;

        const startedAt = Date.now();
        setBrProgress({ label: t('connection.restorePreparing') });
        const resData = await dbHelper.restoreBackup(sqlToRun, tablesToRun, (msg) => {
          const done = msg.done ?? 0;
          const total = msg.total ?? 0;
          if (msg.type === 'start') {
            setBrProgress({ label: t('connection.restoreRunning', { n: total.toLocaleString() }), current: 0, total });
            return;
          }
          // ETA từ tốc độ thật đang chạy
          const elapsed = (Date.now() - startedAt) / 1000;
          const rate = done > 0 ? done / elapsed : 0;
          const remain = rate > 0 && total > done ? Math.round((total - done) / rate) : 0;
          const counts = { done: done.toLocaleString(), total: total.toLocaleString() };
          setBrProgress({
            label: t('connection.restoreInProgress'),
            current: done,
            total,
            detail: remain > 0
              ? t('connection.restoreDetailEta', { ...counts, eta: formatRestoreEta(t, remain) })
              : t('connection.restoreDetail', counts),
          });
        }, brContinueOnError);
        setBrProgress(null);
        if (resData.success) {
          // Có câu bị bỏ qua thì không được báo "thành công" trơn — database chưa đầy đủ.
          setSuccessMsg(
            resData.failedCount
              ? t('app.importDbPartial', { n: resData.statementsCount || 0, failed: resData.failedCount })
              : t('connection.restoreSuccess', { n: resData.statementsCount || 0 })
          );
          if (resData.activeDatabase) {
            if (brType === 'postgres') {
              setBrPgDatabase(resData.activeDatabase);
              setPgDatabase(resData.activeDatabase);
            } else if (brType === 'mysql') {
              setBrMyDatabase(resData.activeDatabase);
              setMyDatabase(resData.activeDatabase);
            }
            setTimeout(() => {
              setActiveType(brType);
            }, 1200);
          }
        } else {
          throw new Error(addExistsHint(resData.error || t('connection.errRestore'), brOverwrite));
        }
      }
    } catch (err: any) {
      setErrorMsg(err.message);
    } finally {
      // Chỉ đóng kết nối do màn này mở. `disconnect()` không tham số đóng kết nối đang active —
      // mà khi `connect()` thất bại thì cái đang active vẫn là kết nối của workspace, tức là nó
      // đóng đúng kết nối người dùng đang dùng dở.
      if (brConnId) await dbHelper.disconnect(brConnId);
      setActiveConnId(prevConnId);
      setBrLoading(false);
      // Lỗi giữa chừng thì thanh tiến độ phải tắt, nếu không nó đứng lại ở % cuối cùng và
      // che luôn chỗ hiện thông báo lỗi.
      setBrProgress(null);
    }
  };

  const _pq = profileSearch.trim().toLowerCase();
  const filteredProfiles = profiles.filter((p) => {
    if (!_pq) return true;
    const cfg: any = p.config || {};
    return [p.name, p.group, p.type, cfg.host, cfg.database, cfg.sqlitePath]
      .some((f) => (f || '').toString().toLowerCase().includes(_pq));
  });
  const groupedProfiles = filteredProfiles.reduce((acc, p) => {
    const groupName = p.group?.trim() || t('connection.defaultGroup');
    if (!acc[groupName]) acc[groupName] = [];
    acc[groupName].push(p);
    return acc;
  }, {} as Record<string, SavedProfile[]>);
  const groupNames = Object.keys(groupedProfiles);
  // Danh sách nhóm đã tồn tại — dùng cho combobox "Nhóm" (chọn lại hoặc nhập mới).
  const existingGroups = Array.from(
    new Set(profiles.map(p => (p.group || '').trim()).filter(Boolean))
  ).sort((a, b) => a.localeCompare(b));

  const isBrMode = (activeType as any) === 'backup_restore';
  const isServerDb = activeType === 'postgres' || activeType === 'mysql';
  const isRedis = activeType === 'redis';
  // Ai có tab SSL + SSH Tunnel. SQLite là tệp cục bộ nên không có gì để mã hoá hay chuyển tiếp.
  const hasNetTabs = isServerDb || isRedis;
  const tlsOn = sslMode !== 'DISABLED';
  // sslMode và sslEnabled phải luôn đi cùng nhau: backend hiểu sslEnabled=true là "bật TLS" kể
  // cả khi mode là DISABLED (để profile cũ chỉ có công tắc vẫn chạy), nên để hai giá trị lệch
  // nhau là bật mã hoá ngoài ý muốn của form.
  const applySslMode = (mode: string) => {
    setSslMode(mode);
    setSslEnabled(mode !== 'DISABLED');
  };
  const activeMeta = TYPE_META[activeType] || TYPE_META.sqlite;
  const hasProfile = !!activeProfileId && !isBrMode;

  // Connection string tóm tắt (không kèm mật khẩu) — hiển thị ở header để đối chiếu nhanh.
  const connectionUri = (() => {
    if (activeType === 'sqlite') return `sqlite://${sqlitePath}`;
    if (activeType === 'redis') return `${tlsOn ? 'rediss' : 'redis'}://${redisUser ? redisUser + '@' : ''}${redisHost}:${redisPort}/${redisDbIndex}`;
    if (activeType === 'postgres') return `postgres://${pgUser}@${pgHost}:${pgPort}/${pgDatabase}`;
    return `mysql://${myUser}@${myHost}:${myPort}/${myDatabase || ''}`;
  })();

  const handleCopyUri = async () => {
    try {
      await navigator.clipboard.writeText(connectionUri);
      setUriCopied(true);
      setTimeout(() => setUriCopied(false), 1600);
    } catch { /* clipboard bị chặn - bỏ qua */ }
  };

  const toggleGroup = (name: string) =>
    setCollapsedGroups((prev) => ({ ...prev, [name]: !prev[name] }));

  const NEW_TYPES: { val: 'sqlite' | 'postgres' | 'mysql' | 'redis'; label: string }[] = [
    { val: 'sqlite', label: 'SQLite' },
    { val: 'postgres', label: 'PostgreSQL' },
    { val: 'mysql', label: 'MySQL' },
    { val: 'redis', label: 'Redis' },
  ];

  // ——— Ô "Cơ sở dữ liệu": nhập tự do + nút tải lại và dropdown chọn từ danh sách ———
  // Gộp nút vào trong ô thay vì để nút "Tải danh sách" nổi riêng một dòng phía trên.
  const renderDatabaseField = (
    value: string,
    setValue: (v: string) => void,
    fetchTarget: 'postgres' | 'mysql' | 'br_postgres' | 'br_mysql',
    placeholder: string,
  ) => {
    const q = value.trim().toLowerCase();
    // Đang gõ dở thì lọc theo từ khoá; nếu đã trùng khít một database thì hiện
    // lại toàn bộ danh sách để còn đổi sang cái khác.
    const exact = availableDatabases.some(d => d.toLowerCase() === q);
    const opts = (!q || exact) ? availableDatabases : availableDatabases.filter(d => d.toLowerCase().includes(q));
    return (
      <div className="form-group">
        <label>{t('connection.databaseLabel')}</label>
        <div className="input-icon-wrapper cm-combo two-btn">
          <input
            type="text"
            className="form-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setShowDbList(false); }}
            placeholder={placeholder}
          />
          <Database size={14} className="input-icon" />
          <button
            type="button"
            className="cm-combo-btn second"
            title={t('connection.reloadDbList')}
            onClick={() => fetchDatabases(fetchTarget)}
            disabled={loadingDbs}
          >
            {loadingDbs ? <LoadingSpinner size={12} /> : <RefreshCw size={13} />}
          </button>
          <button
            type="button"
            className={`cm-combo-btn ${showDbList ? 'on' : ''}`}
            title={t('connection.pickFromList')}
            onClick={() => {
              setShowDbList((v) => !v);
              if (!availableDatabases.length && !loadingDbs) fetchDatabases(fetchTarget);
            }}
          >
            <ChevronDown size={13} />
          </button>
          {showDbList && (
            <>
              <div className="cm-pop-backdrop" onClick={() => setShowDbList(false)} />
              <div className="cm-combo-pop">
                {opts.length === 0 ? (
                  <div className="cm-combo-empty">
                    {loadingDbs
                      ? t('connection.dbListLoading')
                      : availableDatabases.length ? t('connection.dbListNoMatch') : t('connection.dbListNotLoaded')}
                  </div>
                ) : opts.map(d => (
                  <button
                    key={d}
                    type="button"
                    className={`cm-combo-opt ${d === value.trim() ? 'on' : ''}`}
                    onClick={() => { setValue(d); setShowDbList(false); }}
                  >
                    <span className="cm-ellipsis">{d}</span>
                    {d === value.trim() && <Check size={12} style={{ flexShrink: 0 }} />}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    );
  };

  // ——— Khối "Thông tin cơ bản": tên, nhóm, màu nhận diện ———
  const renderBasicSection = () => (
    <div className="cm-section">
      <div className="cm-section-title">{t('connection.basicSection')}</div>
      <div className="cm-fields">
        <div className="cm-grid basic">
          <div className="form-group">
            <label>{t('connection.profileName')}</label>
            <input
              type="text"
              className="form-input"
              value={profileNameInput}
              onChange={(e) => setProfileNameInput(e.target.value)}
              placeholder={t('connection.profileNamePlaceholder')}
            />
          </div>
          <div className="form-group">
            <label>{t('connection.group')}</label>
            {/* Combobox tự dựng thay cho <datalist>: native datalist hiện thêm một
                mũi tên riêng và popup không theo được theme của app. */}
            <div className="cm-combo">
              <input
                type="text"
                className="form-input"
                value={profileGroup}
                onChange={(e) => setProfileGroup(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') setShowGroupList(false); }}
                placeholder={existingGroups.length ? t('connection.groupPlaceholderPick') : t('connection.groupPlaceholderNew')}
              />
              {existingGroups.length > 0 && (
                <button
                  type="button"
                  className={`cm-combo-btn ${showGroupList ? 'on' : ''}`}
                  title={t('connection.pickExistingGroup')}
                  onClick={() => setShowGroupList((v) => !v)}
                >
                  <ChevronDown size={13} />
                </button>
              )}
              {showGroupList && (
                <>
                  <div className="cm-pop-backdrop" onClick={() => setShowGroupList(false)} />
                  <div className="cm-combo-pop">
                    {existingGroups.map(g => (
                      <button
                        key={g}
                        type="button"
                        className={`cm-combo-opt ${g === profileGroup.trim() ? 'on' : ''}`}
                        onClick={() => { setProfileGroup(g); setShowGroupList(false); }}
                      >
                        <span className="cm-ellipsis">{g}</span>
                        {g === profileGroup.trim() && <Check size={12} style={{ flexShrink: 0 }} />}
                      </button>
                    ))}
                    {profileGroup.trim() && (
                      <>
                        <div className="cm-pop-sep" />
                        <button type="button" className="cm-combo-opt" onClick={() => { setProfileGroup(''); setShowGroupList(false); }}>
                          <X size={12} style={{ flexShrink: 0 }} />
                          <span>{t('connection.clearGroup')}</span>
                        </button>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
          {/* Môi trường */}
          <div className="form-group">
            <label>{t('connEnv.label')}</label>
            <select
              className="form-input"
              value={profileEnv}
              onChange={(e) => setProfileEnv(normalizeEnv(e.target.value))}
            >
              {CONN_ENVS.map((env) => (
                <option key={env} value={env}>{t(envLabelKey(env))}</option>
              ))}
            </select>
          </div>
        </div>
        {profileEnv === 'production' && <small className="cm-hint">{t('connEnv.hint')}</small>}
      </div>
    </div>
  );

  // ——— Cảnh báo kết nối từ xa nhưng chưa bật mã hoá ———
  const renderSslWarning = () => {
    if (activeType === 'redis') {
      if (tlsOn || !isRemoteHost(redisHost)) return null;
      return (
        <div className="cm-warn">
          <ShieldAlert size={15} style={{ flexShrink: 0 }} />
          <span style={{ flex: 1 }}>
            <Trans i18nKey="connection.warnRedisTls" components={{ strong: <b /> }} />
          </span>
          <button type="button" className="cm-warn-btn" onClick={() => applySslMode('VERIFY_IDENTITY')}>{t('connection.enableTls')}</button>
        </div>
      );
    }
    if (!isServerDb) return null;
    const host = activeType === 'postgres' ? pgHost : myHost;
    if (sslMode !== 'DISABLED' || !isRemoteHost(host)) return null;
    return (
      <div className="cm-warn">
        <ShieldAlert size={15} style={{ flexShrink: 0 }} />
        <span style={{ flex: 1 }}>
          <Trans i18nKey="connection.warnSslDisabled" components={{ strong: <b /> }} />
        </span>
        <button type="button" className="cm-warn-btn" onClick={() => { setSslMode('REQUIRED'); setFormTab('ssl'); }}>{t('connection.enableSsl')}</button>
      </div>
    );
  };

  const handlePickSqlitePath = async () => {
    const file = await pickSqliteDatabaseFile(sqlitePath);
    if (file) {
      setSqlitePath(file);
      const filename = file.split(/[\\/]/).pop();
      if (filename && (!profileNameInput || profileNameInput.toLowerCase().includes('sqlite') || profileNameInput.trim() === '')) {
        setProfileNameInput(filename.replace(/\.[^/.]+$/, ''));
      }
    }
  };

  // ——— Tab "Chung" cho từng loại DB ———
  const renderGeneralTab = () => (
    <>
      {renderBasicSection()}

      {activeType === 'sqlite' && (
        <div className="cm-section">
          <div className="cm-section-title">{t('connection.sqliteSection')}</div>
          <div className="cm-section-desc">{t('connection.sqliteDesc')}</div>
          <div className="cm-fields">
            <div className="form-group">
              <label>{t('connection.sqlitePathLabel')}</label>
              <div className="cm-file-row">
                <div className="input-icon-wrapper">
                  <input
                    type="text"
                    className="form-input"
                    value={sqlitePath}
                    onChange={(e) => setSqlitePath(e.target.value)}
                    placeholder={t('connection.sqlitePathPlaceholder')}
                  />
                  <FolderOpen size={14} className="input-icon" />
                </div>
                <button
                  type="button"
                  className="cm-file-btn"
                  onClick={handlePickSqlitePath}
                  title={t('connection.pickFile')}
                >
                  <FolderOpen size={12} />
                  <span>{t('connection.pickFile')}</span>
                </button>
              </div>
              <span className="cm-hint">{t('connection.sqliteHint')}</span>
            </div>
          </div>
        </div>
      )}

      {activeType === 'redis' && (
        <div className="cm-section">
          <div className="cm-section-title">{t('connection.redisSection')}</div>
          <div className="cm-section-desc">{t('connection.redisDesc')}</div>
          <div className="cm-fields">
            <div className="cm-grid host">
              <div className="form-group">
                <label>{t('connection.host')}</label>
                <div className="input-icon-wrapper">
                  <input type="text" className="form-input" value={redisHost} onChange={(e) => setRedisHost(e.target.value)} placeholder="127.0.0.1" />
                  <Server size={14} className="input-icon" />
                </div>
              </div>
              <div className="form-group">
                <label>{t('connection.port')}</label>
                <div className="input-icon-wrapper">
                  <input type="number" className="form-input" value={redisPort} onChange={(e) => setRedisPort(parseInt(e.target.value) || 6379)} />
                  <Hash size={14} className="input-icon" />
                </div>
              </div>
            </div>
            <div className="cm-grid two">
              <div className="form-group">
                <label>{t('connection.redisUserLabel')}</label>
                <div className="input-icon-wrapper">
                  <input type="text" className="form-input" value={redisUser} onChange={(e) => setRedisUser(e.target.value)} placeholder="default" />
                  <User size={14} className="input-icon" />
                </div>
              </div>
              <div className="form-group">
                <label>{t('connection.password')}</label>
                <div className="input-icon-wrapper">
                  <input
                    type={showPw ? 'text' : 'password'}
                    className="form-input"
                    value={redisPassword}
                    onChange={(e) => setRedisPassword(e.target.value)}
                    placeholder="••••••••"
                    style={{ paddingRight: '32px' }}
                  />
                  <Key size={14} className="input-icon" />
                  <EyeBtn on={showPw} onClick={() => setShowPw((v) => !v)} />
                </div>
              </div>
            </div>
            <div className="cm-grid two">
              <div className="form-group">
                <label>{t('connection.redisDbIndex')}</label>
                <input
                  type="number"
                  min={0}
                  max={15}
                  className="form-input"
                  value={redisDbIndex}
                  onChange={(e) => setRedisDbIndex(Math.max(0, Math.min(15, parseInt(e.target.value) || 0)))}
                />
              </div>
            </div>
            {/* Công tắc một chạm cho trường hợp phổ biến; mức kiểm tra chứng chỉ, CA và mTLS
                nằm ở tab SSL. Bật ở đây = VERIFY_IDENTITY, đúng bằng hành vi của công tắc
                trước khi tab SSL tồn tại. */}
            <div className="cm-switch-row">
              <button type="button" className={`cm-switch ${tlsOn ? 'on' : ''}`} onClick={() => applySslMode(tlsOn ? 'DISABLED' : 'VERIFY_IDENTITY')} aria-label={t('connection.enableTls')} />
              <div style={{ flex: 1 }}>
                <div className="cm-switch-label">{t('connection.tlsSwitchLabel')}</div>
                <div className="cm-hint">{t('connection.tlsSwitchHint')}</div>
                {tlsOn && (
                  <div className="cm-hint">
                    <Trans
                      i18nKey="connection.tlsSwitchModeHint"
                      values={{ mode: sslMode }}
                      components={{ strong: <b /> }}
                    />
                  </div>
                )}
              </div>
            </div>
            {renderSslWarning()}
          </div>
        </div>
      )}

      {isServerDb && (() => {
        const host = activeType === 'postgres' ? pgHost : myHost;
        const setHost = activeType === 'postgres' ? setPgHost : setMyHost;
        const port = activeType === 'postgres' ? pgPort : myPort;
        const setPort = activeType === 'postgres' ? setPgPort : setMyPort;
        const defPort = activeType === 'postgres' ? 5432 : 3306;
        const user = activeType === 'postgres' ? pgUser : myUser;
        const setUser = activeType === 'postgres' ? setPgUser : setMyUser;
        const password = activeType === 'postgres' ? pgPassword : myPassword;
        const setPassword = activeType === 'postgres' ? setPgPassword : setMyPassword;
        const database = activeType === 'postgres' ? pgDatabase : myDatabase;
        const setDatabase = activeType === 'postgres' ? setPgDatabase : setMyDatabase;

        return (
          <>
            <div className="cm-section">
              <div className="cm-section-title">{t('connection.serverSection')}</div>
              <div className="cm-section-desc">{t('connection.serverDesc', { db: activeMeta.label })}</div>
              <div className="cm-fields">
                <div className="cm-grid host">
                  <div className="form-group">
                    <label>{t('connection.host')}</label>
                    <div className="input-icon-wrapper">
                      <input
                        type="text"
                        className="form-input"
                        value={host}
                        onChange={(e) => setHost(e.target.value)}
                        placeholder="localhost"
                      />
                      <Server size={14} className="input-icon" />
                    </div>
                  </div>
                  <div className="form-group">
                    <label>{t('connection.port')}</label>
                    <div className="input-icon-wrapper">
                      <input
                        type="number"
                        className="form-input"
                        value={port}
                        onChange={(e) => setPort(parseInt(e.target.value) || defPort)}
                      />
                      <Hash size={14} className="input-icon" />
                    </div>
                  </div>
                </div>
                {renderDatabaseField(
                  database,
                  setDatabase,
                  activeType === 'postgres' ? 'postgres' : 'mysql',
                  activeType === 'postgres' ? 'postgres' : t('connection.databaseOptional'),
                )}
                {renderSslWarning()}
              </div>
            </div>

            <div className="cm-section">
              <div className="cm-label-row">
                <div>
                  <div className="cm-section-title">{t('connection.authSection')}</div>
                  <div className="cm-section-desc">{t('connection.authDesc')}</div>
                </div>
                <div className="cm-seg">
                  <button type="button" className={authMethod === 'password' ? 'on' : ''} onClick={() => setAuthMethod('password')}>{t('connection.authPassword')}</button>
                  <button type="button" className={authMethod === 'aws_iam' ? 'on' : ''} onClick={() => setAuthMethod('aws_iam')}>{t('connection.authAwsIam')}</button>
                </div>
              </div>
              <div className="cm-fields">
                <div className="cm-grid two">
                  <div className="form-group">
                    <label>{authMethod === 'aws_iam' ? t('connection.usernameIam') : t('connection.username')}</label>
                    <div className="input-icon-wrapper">
                      <input
                        type="text"
                        className="form-input"
                        value={user}
                        onChange={(e) => setUser(e.target.value)}
                        placeholder={activeType === 'postgres' ? 'postgres' : 'root'}
                      />
                      <User size={14} className="input-icon" />
                    </div>
                  </div>
                  {authMethod === 'password' && (
                    <div className="form-group">
                      <label>{t('connection.password')}</label>
                      <div className="input-icon-wrapper">
                        <input
                          type={showPw ? 'text' : 'password'}
                          className="form-input"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          placeholder="••••••••"
                          style={{ paddingRight: '32px' }}
                        />
                        <Key size={14} className="input-icon" />
                        <EyeBtn on={showPw} onClick={() => setShowPw((v) => !v)} />
                      </div>
                    </div>
                  )}
                </div>

                {authMethod === 'aws_iam' && (
                  <div className="cm-subcard">
                    <div className="cm-subcard-head">
                      <Cloud size={13} />
                      <span>{t('connection.awsHeading')}</span>
                    </div>
                    <div className="cm-hint" style={{ marginBottom: '12px' }}>
                      <Trans i18nKey="connection.awsHint" components={{ strong: <b /> }} />
                    </div>
                    <div className="cm-seg" style={{ marginBottom: '12px' }}>
                      <button type="button" className={awsAuthType === 'access_key' ? 'on' : ''} onClick={() => setAwsAuthType('access_key')}>{t('connection.awsAccessKeySeg')}</button>
                      <button type="button" className={awsAuthType === 'profile' ? 'on' : ''} onClick={() => setAwsAuthType('profile')}>{t('connection.awsProfileSeg')}</button>
                    </div>
                    <div className="cm-fields" style={{ marginTop: 0 }}>
                      {awsAuthType === 'access_key' ? (
                        <>
                          <div className="form-group">
                            <label>{t('connection.awsAccessKeyId')}</label>
                            <input type="text" className="form-input" value={awsAccessKeyId} onChange={(e) => setAwsAccessKeyId(e.target.value)} placeholder="AKIA..." autoComplete="off" />
                          </div>
                          <div className="cm-grid two">
                            <div className="form-group">
                              <label>{t('connection.awsSecretKey')}</label>
                              <div className="input-icon-wrapper">
                                <input type={showPw ? 'text' : 'password'} className="form-input" value={awsSecretAccessKey} onChange={(e) => setAwsSecretAccessKey(e.target.value)} autoComplete="off" style={{ paddingRight: '32px', paddingLeft: '10px' }} />
                                <EyeBtn on={showPw} onClick={() => setShowPw((v) => !v)} />
                              </div>
                            </div>
                            <div className="form-group">
                              <label>{t('connection.awsSessionToken')}</label>
                              <div className="input-icon-wrapper">
                                <input type={showPw ? 'text' : 'password'} className="form-input" value={awsSessionToken} onChange={(e) => setAwsSessionToken(e.target.value)} autoComplete="off" style={{ paddingRight: '32px', paddingLeft: '10px' }} />
                                <EyeBtn on={showPw} onClick={() => setShowPw((v) => !v)} />
                              </div>
                            </div>
                          </div>
                        </>
                      ) : (
                        <div className="form-group">
                          <label>{t('connection.awsProfileName')}</label>
                          <input type="text" className="form-input" value={awsProfile} onChange={(e) => setAwsProfile(e.target.value)} placeholder="default" autoComplete="off" />
                        </div>
                      )}
                      <div className="form-group">
                        <label>{t('connection.awsRegion')}</label>
                        <input type="text" className="form-input" value={awsRegion} onChange={(e) => setAwsRegion(e.target.value)} placeholder={t('connection.awsRegionPlaceholder')} autoComplete="off" />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        );
      })()}
    </>
  );

  // ——— Tab "SSL" (Postgres / MySQL / Redis) ———
  const renderSslTab = () => {
    const prefix = isRedis ? 'redis' : activeType === 'postgres' ? 'pg' : 'my';
    const sslOn = tlsOn;
    // Hai mode VERIFY_* mới thực sự kiểm tra chứng chỉ máy chủ -> CA cert lúc đó
    // là bắt buộc (nếu CA không nằm trong store của hệ thống). REQUIRED thì 3 ô
    // này chỉ phục vụ mTLS.
    const needVerify = sslMode === 'VERIFY_CA' || sslMode === 'VERIFY_IDENTITY';
    return (
      <div className="cm-section">
        <div className="cm-section-title">{t('connection.sslSection')}</div>
        <div className="cm-section-desc">
          <Trans i18nKey="connection.sslDesc" components={{ strong: <b /> }} />
        </div>
        <div className="cm-fields">
          <div className="form-group">
            <label>{t('connection.sslModeLabel')}</label>
            <select className="form-input" value={sslMode} onChange={(e) => (isRedis ? applySslMode(e.target.value) : setSslMode(e.target.value))} style={{ maxWidth: '240px' }}>
              {(isRedis ? REDIS_SSL_MODES : SSL_MODES).map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            <span className="cm-hint">{sslModeDesc(sslMode)}</span>
          </div>

          {/* Tunnel làm client kết nối tới 127.0.0.1, nên chứng chỉ của server được đối chiếu
              với địa chỉ đó và VERIFY_IDENTITY chắc chắn hỏng. VERIFY_CA vẫn kiểm tra chuỗi
              chứng chỉ, chỉ bỏ qua tên miền. */}
          {isRedis && sshEnabled && sslMode === 'VERIFY_IDENTITY' && (
            <div className="cm-warn">
              <ShieldAlert size={15} style={{ flexShrink: 0 }} />
              <span style={{ flex: 1 }}>
                <Trans i18nKey="connection.warnRedisTlsOverSsh" components={{ strong: <b /> }} />
              </span>
              <button type="button" className="cm-warn-btn" onClick={() => applySslMode('VERIFY_CA')}>{t('connection.useVerifyCa')}</button>
            </div>
          )}

          {renderSslWarning()}

          {sslOn && (
            <div className="cm-subcard">
              <div className="cm-label-row" style={{ marginBottom: '12px' }}>
                <div className="cm-subcard-head" style={{ margin: 0 }}>
                  <ShieldCheck size={13} />
                  <span>{needVerify ? t('connection.certs') : t('connection.certsOptional')}</span>
                </div>
                <button
                  type="button"
                  className="cm-mini-btn"
                  onClick={() => { setSslKeyPath(''); setSslCertPath(''); setSslCaPath(''); }}
                  disabled={!sslKeyPath && !sslCertPath && !sslCaPath}
                >
                  <X size={10} /> <span>{t('connection.clearAll')}</span>
                </button>
              </div>
              <div className="cm-grid three">
                <div className="form-group">
                  <label>{t('connection.clientKey')}</label>
                  <FilePick id={`${prefix}-ssl-key-picker`} value={sslKeyPath} label={t('connection.pickKey')} onPick={setSslKeyPath} />
                </div>
                <div className="form-group">
                  <label>{t('connection.clientCert')}</label>
                  <FilePick id={`${prefix}-ssl-cert-picker`} value={sslCertPath} label={t('connection.pickCert')} onPick={setSslCertPath} />
                </div>
                <div className="form-group">
                  <label>{t('connection.caCert')}{needVerify ? ' *' : ''}</label>
                  <FilePick id={`${prefix}-ssl-ca-picker`} value={sslCaPath} label={t('connection.pickCa')} onPick={setSslCaPath} />
                </div>
              </div>
              <div className="cm-hint" style={{ marginTop: '10px' }}>
                <Trans i18nKey="connection.certHintBase" components={{ strong: <b /> }} />{' '}
                {needVerify ? (
                  <Trans i18nKey="connection.certHintVerify" components={{ strong: <b /> }} />
                ) : isRedis ? (
                  <Trans i18nKey="connection.certHintRedis" components={{ strong: <b /> }} />
                ) : activeType === 'postgres' ? (
                  <Trans i18nKey="connection.certHintPostgres" components={{ strong: <b /> }} />
                ) : (
                  <Trans i18nKey="connection.certHintMysql" components={{ strong: <b /> }} />
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  // ——— Tab "SSH Tunnel" ———
  const renderSshTab = () => (
    <div className="cm-section">
      <div className="cm-section-title">{t('connection.sshSection')}</div>
      <div className="cm-section-desc">{t('connection.sshDesc')}</div>
      <div className="cm-fields">
        <div className="cm-switch-row">
          <button type="button" className={`cm-switch ${sshEnabled ? 'on' : ''}`} onClick={() => setSshEnabled(!sshEnabled)} aria-label={t('connection.sshEnableAria')} />
          <div style={{ flex: 1 }}>
            <div className="cm-switch-label">{t('connection.sshSwitchLabel')}</div>
            <div className="cm-hint">{t('connection.sshSwitchHint')}</div>
          </div>
        </div>

        {sshEnabled && (
          <>
            <div className="cm-grid host">
              <div className="form-group">
                <label>{t('connection.sshHost')}</label>
                <div className="input-icon-wrapper">
                  <input type="text" className="form-input" value={sshHost} onChange={(e) => setSshHost(e.target.value)} placeholder="bastion.example.com" />
                  <Network size={14} className="input-icon" />
                </div>
              </div>
              <div className="form-group">
                <label>{t('connection.sshPort')}</label>
                <div className="input-icon-wrapper">
                  <input type="number" className="form-input" value={sshPort} onChange={(e) => setSshPort(parseInt(e.target.value) || 22)} />
                  <Hash size={14} className="input-icon" />
                </div>
              </div>
            </div>
            {/* Chọn cách xác thực bằng segmented ở dòng tiêu đề (giống khối
                "Xác thực" ở tab Chung) để user + mật khẩu/passphrase luôn nằm
                cùng một dòng 2 cột, không còn field lẻ loi nửa dòng. */}
            <div className="cm-label-row">
              <span className="cm-subhead">{t('connection.sshAuthHeading')}</span>
              <div className="cm-seg">
                <button type="button" className={sshAuthType === 'password' ? 'on' : ''} onClick={() => setSshAuthType('password')}>{t('connection.authPassword')}</button>
                <button type="button" className={sshAuthType === 'key' ? 'on' : ''} onClick={() => setSshAuthType('key')}>{t('connection.sshAuthKey')}</button>
              </div>
            </div>

            <div className="cm-grid two">
              <div className="form-group">
                <label>{t('connection.sshUser')}</label>
                <div className="input-icon-wrapper">
                  <input type="text" className="form-input" value={sshUser} onChange={(e) => setSshUser(e.target.value)} placeholder="ubuntu" />
                  <User size={14} className="input-icon" />
                </div>
              </div>
              {sshAuthType === 'password' ? (
                <div className="form-group">
                  <label>{t('connection.sshPassword')}</label>
                  <div className="input-icon-wrapper">
                    <input
                      type={showPw ? 'text' : 'password'}
                      className="form-input"
                      value={sshPassword}
                      onChange={(e) => setSshPassword(e.target.value)}
                      placeholder="••••••••"
                      style={{ paddingRight: '32px' }}
                    />
                    <Key size={14} className="input-icon" />
                    <EyeBtn on={showPw} onClick={() => setShowPw((v) => !v)} />
                  </div>
                </div>
              ) : (
                <div className="form-group">
                  <label>{t('connection.sshPassphrase')}</label>
                  <div className="input-icon-wrapper">
                    <input
                      type={showPw ? 'text' : 'password'}
                      className="form-input"
                      value={sshPassphrase}
                      onChange={(e) => setSshPassphrase(e.target.value)}
                      placeholder="••••••••"
                      style={{ paddingRight: '32px' }}
                    />
                    <Key size={14} className="input-icon" />
                    <EyeBtn on={showPw} onClick={() => setShowPw((v) => !v)} />
                  </div>
                </div>
              )}
            </div>

            {sshAuthType === 'key' && (
              <div className="cm-subcard">
                <div className="cm-subcard-head">
                  <Key size={13} />
                  <span>{t('connection.sshAuthKey')}</span>
                </div>
                <div className="cm-fields" style={{ marginTop: 0 }}>
                  <div className="form-group">
                    <label>{t('connection.sshKeyPath')}</label>
                    <div className="cm-file-row">
                      <input
                        type="text"
                        className="form-input"
                        value={sshKeyPath}
                        onChange={(e) => setSshKeyPath(e.target.value)}
                        placeholder="C:\Users\me\.ssh\id_rsa"
                      />
                      <FilePick id="ssh-key-file-picker" value="" label={t('connection.pickFile')} onPick={setSshKeyPath} />
                    </div>
                  </div>
                  <div className="form-group">
                    <label>{t('connection.sshKeyContent')}</label>
                    <textarea
                      className="form-input cm-key-area"
                      value={sshKeyContent}
                      onChange={(e) => setSshKeyContent(e.target.value)}
                      placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;..."
                    />
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );

  // Cắt dump MỘT lần cho mỗi tệp và ghi sẵn thứ cần cho bộ lọc. Trước đây phần đếm cắt lại
  // cả tệp mỗi khi danh sách bảng chọn đổi, nên với dump lớn thì mỗi cái tick treo giao diện.
  const brStatements = React.useMemo(() => {
    if (!brSqlText) return [];
    return splitStatements(brSqlText).map(({ text }) => {
      const body = stripLeadingSqlComments(text);
      const { commentOnly, willRun } = commentOnlyFromBody(text, body);
      return {
        table: dumpStatementObject(body),
        skipped: isSkippedDumpBody(body),
        commentOnly,
        commentRuns: willRun,
      };
    });
  }, [brSqlText]);

  // Không phụ thuộc `brOverwrite`: bật/tắt ô ghi đè không phải quét lại cả tệp.
  const brDropStatements = React.useMemo(
    () => (brSqlText ? buildDropStatements(parseDumpObjects(brSqlText), brType) : []),
    [brSqlText, brType]
  );

  // Số câu lệnh sẽ chạy khi phục hồi (cùng bộ lọc theo bảng với backend) để ước tính thời gian.
  const brPlannedStatements = React.useMemo(() => {
    // Không đặt tên tham số là `t` — đó là hàm dịch.
    const selectedLower = new Set(brSelectedTables.map((name) => name.toLowerCase()));
    let n = brOverwrite ? brDropStatements.length : 0;
    for (const s of brStatements) {
      // Cùng luật với backend: bỏ LOCK/UNLOCK TABLES + lệnh transaction của dump...
      if (s.skipped) continue;
      if (s.commentOnly) {
        if (s.commentRuns) n++;
        continue;
      }
      // ...câu không nhắc bảng nào (SET/USE...) vẫn chạy; còn lại phải thuộc bảng đã chọn.
      if (brParsedTables.length === 0 || !s.table || selectedLower.has(s.table.toLowerCase())) n++;
    }
    return n;
  }, [brStatements, brDropStatements, brOverwrite, brParsedTables.length, brSelectedTables]);

  const brTargetDb = brType === 'postgres' ? brPgDatabase : brType === 'mysql' ? brMyDatabase : brSqlitePath;

  // ——— Chế độ Sao lưu & Phục hồi (không cần kết nối sẵn) ———
  const renderBackupRestore = () => (
    <>
      {/* Tóm tắt trước khi phục hồi: vào database nào, bao nhiêu bảng/câu lệnh, ước tính bao lâu */}
      <ConfirmDialog
        open={brConfirm}
        tone={brOverwrite ? 'danger' : 'info'}
        title={t('connection.brConfirmTitle')}
        message={
          <>
            <div>
              {brType === 'sqlite' ? (
                <Trans
                  i18nKey="connection.brRestoreInto"
                  values={{ db: brTargetDb || t('connection.brTargetDefault') }}
                  components={{ code: <b style={{ fontFamily: 'monospace' }} /> }}
                />
              ) : (
                <Trans
                  i18nKey="connection.brRestoreIntoHost"
                  values={{
                    db: brTargetDb || t('connection.brTargetDefault'),
                    host: brType === 'mysql' ? brMyHost : brPgHost,
                  }}
                  components={{ code: <b style={{ fontFamily: 'monospace' }} /> }}
                />
              )}
              {!brTargetDb && brType !== 'sqlite' && (
                <>{' '}<Trans i18nKey="connection.brUseHint" components={{ code: <code style={{ fontFamily: 'monospace' }} /> }} /></>
              )}
            </div>
            <div style={{ marginTop: '8px', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 10px' }}>
              <span style={{ color: 'var(--win-text-secondary)' }}>{t('connection.brRowTables')}</span>
              <b>{brParsedTables.length === 0
                ? t('connection.brAllFile')
                : t('connection.brTablesCount', { selected: brSelectedTables.length, total: brParsedTables.length })}</b>
              <span style={{ color: 'var(--win-text-secondary)' }}>{t('connection.brRowStatements')}</span>
              <b>{brPlannedStatements.toLocaleString()}</b>
              <span style={{ color: 'var(--win-text-secondary)' }}>{t('connection.brRowFile')}</span>
              <b>{brFile ? `${brFile.name} (${(brFile.size / 1024 / 1024).toFixed(2)} MB)` : ''}</b>
              <span style={{ color: 'var(--win-text-secondary)' }}>{t('connection.brRowEta')}</span>
              <b>~{formatRestoreEta(t, brPlannedStatements / 800)}</b>
            </div>
          </>
        }
        note={brOverwrite ? t('connection.brNoteOverwrite') : t('connection.brNoteEstimate')}
        confirmLabel={t('connection.brStartRestore')}
        cancelLabel={t('connection.back')}
        onConfirm={() => handleBrSubmit()}
        onCancel={() => setBrConfirm(false)}
      />

      <div className="cm-section">
        <div className="cm-label-row">
          <div>
            <div className="cm-section-title">{brAction === 'backup' ? t('connection.brBackupTitle') : t('connection.brRestoreTitle')}</div>
            <div className="cm-section-desc">
              {brAction === 'backup' ? t('connection.brBackupDesc') : t('connection.brRestoreDesc')}
            </div>
          </div>
          <div className="cm-seg">
            <button type="button" className={brAction === 'backup' ? 'on' : ''} onClick={() => setBrAction('backup')}>{t('connection.brSegBackup')}</button>
            <button type="button" className={brAction === 'restore' ? 'on' : ''} onClick={() => setBrAction('restore')}>{t('connection.brSegRestore')}</button>
          </div>
        </div>

        <div className="cm-fields">
          <div className="cm-grid two">
            <div className="form-group">
              <label>{t('connection.brFromProfile')}</label>
              <select
                className="form-input"
                value={selectedBrProfileId || ''}
                onChange={async (e) => {
                  const profId = e.target.value;
                  setSelectedBrProfileId(profId);
                  const selectedProf = profiles.find(p => p.id === profId);
                  if (selectedProf) {
                    setBrType(selectedProf.type === 'redis' ? 'sqlite' : selectedProf.type);
                    // Mật khẩu nằm trong kho HĐH -> phải đọc ra mới điền được vào form sao lưu.
                    const c = await configWithSecrets(selectedProf);
                    if (selectedProf.type === 'sqlite') {
                      setBrSqlitePath(c.sqlitePath || '');
                    } else if (selectedProf.type === 'postgres') {
                      setBrPgHost(c.host || 'localhost');
                      setBrPgPort(c.port || 5432);
                      setBrPgUser(c.user || 'postgres');
                      setBrPgPassword(c.password || '');
                      setBrPgDatabase(c.database || 'postgres');
                    } else if (selectedProf.type === 'mysql') {
                      setBrMyHost(c.host || 'localhost');
                      setBrMyPort(c.port || 3306);
                      setBrMyUser(c.user || 'root');
                      setBrMyPassword(c.password || '');
                      setBrMyDatabase(c.database || '');
                    }
                  }
                }}
              >
                <option value="">{t('connection.brManual')}</option>
                {profiles.map(p => (
                  <option key={p.id} value={p.id}>{p.name} ({p.type.toUpperCase()})</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label>{t('connection.brDbType')}</label>
              <select className="form-input" value={brType} onChange={(e) => setBrType(e.target.value as any)}>
                <option value="sqlite">SQLite</option>
                <option value="postgres">PostgreSQL</option>
                <option value="mysql">MySQL</option>
              </select>
            </div>
          </div>

          {brType === 'sqlite' ? (
            <div className="form-group">
              <label>{t('connection.brSqlitePath')}</label>
              <div className="cm-file-row">
                <div className="input-icon-wrapper">
                  <input
                    type="text"
                    className="form-input"
                    value={brSqlitePath}
                    onChange={(e) => setBrSqlitePath(e.target.value)}
                    placeholder={t('connection.sqlitePathPlaceholder')}
                  />
                  <FolderOpen size={14} className="input-icon" />
                </div>
                <button
                  type="button"
                  className="cm-file-btn"
                  onClick={async () => {
                    const picked = await pickSqliteDatabaseFile(brSqlitePath);
                    if (picked) setBrSqlitePath(picked);
                  }}
                  title={t('connection.pickFile')}
                >
                  <FolderOpen size={12} />
                  <span>{t('connection.pickFile')}</span>
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="cm-grid host">
                <div className="form-group">
                  <label>{t('connection.host')}</label>
                  <div className="input-icon-wrapper">
                    <input
                      type="text"
                      className="form-input"
                      value={brType === 'postgres' ? brPgHost : brMyHost}
                      onChange={(e) => brType === 'postgres' ? setBrPgHost(e.target.value) : setBrMyHost(e.target.value)}
                    />
                    <Server size={14} className="input-icon" />
                  </div>
                </div>
                <div className="form-group">
                  <label>{t('connection.port')}</label>
                  <div className="input-icon-wrapper">
                    <input
                      type="number"
                      className="form-input"
                      value={brType === 'postgres' ? brPgPort : brMyPort}
                      onChange={(e) => brType === 'postgres' ? setBrPgPort(parseInt(e.target.value) || 5432) : setBrMyPort(parseInt(e.target.value) || 3306)}
                    />
                    <Hash size={14} className="input-icon" />
                  </div>
                </div>
              </div>
              <div className="cm-grid two">
                <div className="form-group">
                  <label>{t('connection.username')}</label>
                  <div className="input-icon-wrapper">
                    <input
                      type="text"
                      className="form-input"
                      value={brType === 'postgres' ? brPgUser : brMyUser}
                      onChange={(e) => brType === 'postgres' ? setBrPgUser(e.target.value) : setBrMyUser(e.target.value)}
                    />
                    <User size={14} className="input-icon" />
                  </div>
                </div>
                <div className="form-group">
                  <label>{t('connection.password')}</label>
                  <div className="input-icon-wrapper">
                    <input
                      type={showPw ? 'text' : 'password'}
                      className="form-input"
                      value={brType === 'postgres' ? brPgPassword : brMyPassword}
                      onChange={(e) => brType === 'postgres' ? setBrPgPassword(e.target.value) : setBrMyPassword(e.target.value)}
                      style={{ paddingRight: '32px' }}
                    />
                    <Key size={14} className="input-icon" />
                    <EyeBtn on={showPw} onClick={() => setShowPw((v) => !v)} />
                  </div>
                </div>
              </div>
              {renderDatabaseField(
                brType === 'postgres' ? brPgDatabase : brMyDatabase,
                brType === 'postgres' ? setBrPgDatabase : setBrMyDatabase,
                brType === 'postgres' ? 'br_postgres' : 'br_mysql',
                brType === 'postgres' ? 'postgres' : t('connection.databaseOptional'),
              )}
            </>
          )}
        </div>
      </div>

      <div className="cm-section">
        {brAction === 'backup' ? (
          <>
            <div className="cm-section-title">{t('connection.brExportOptions')}</div>
            <div className="cm-fields">
              <div className="form-group" style={{ maxWidth: '340px' }}>
                <label>{t('connection.brFilename')}</label>
                <input
                  type="text"
                  className="form-input"
                  value={brEffectiveFilename}
                  onChange={(e) => { setBrFilenameTouched(true); setBrFilename(e.target.value); }}
                />
                <div className="cm-hint">{brEffectiveFilename}{brCompressGzip ? '.sql.gz' : '.sql'}</div>
              </div>
              <div className="cm-check-grid">
                <label className="cm-check"><input type="checkbox" checked={brDropTable} onChange={(e) => setBrDropTable(e.target.checked)} /><span>DROP TABLE IF EXISTS</span></label>
                <label className="cm-check"><input type="checkbox" checked={brIncludeStructure} onChange={(e) => setBrIncludeStructure(e.target.checked)} /><span>{t('connection.brIncludeStructure')}</span></label>
                <label className="cm-check"><input type="checkbox" checked={brIncludeContent} onChange={(e) => setBrIncludeContent(e.target.checked)} /><span>{t('connection.brIncludeContent')}</span></label>
                <label className="cm-check"><input type="checkbox" checked={brCompressGzip} onChange={(e) => setBrCompressGzip(e.target.checked)} /><span>{t('connection.brGzip')}</span></label>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="cm-section-title">{t('connection.brFileSection')}</div>
            <div className="cm-fields">
              <label className="cm-dropzone">
                <input
                  type="file"
                  accept=".sql,.dump,.gz"
                  onChange={(e) => setBrFile(e.target.files?.[0] || null)}
                  style={{ display: 'none' }}
                />
                <Upload size={18} />
                <div>
                  <div className="cm-dropzone-title">{brFile ? brFile.name : t('connection.brPickFile')}</div>
                  <div className="cm-hint">{brFile ? t('connection.brFileSize', { size: (brFile.size / 1024 / 1024).toFixed(2) }) : t('connection.brPickHint')}</div>
                </div>
              </label>

              {brParsing && (
                <div className="cm-hint" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <LoadingSpinner size={11} /> {t('connection.brParsingTables')}
                </div>
              )}

              {brParsedTables.length > 0 && (
                <div className="cm-subcard">
                  <div className="cm-label-row" style={{ marginBottom: '10px' }}>
                    <div className="cm-subcard-head" style={{ margin: 0 }}>
                      <Database size={13} />
                      <span>{t('connection.brTablesToRestore', { selected: brSelectedTables.length, total: brParsedTables.length })}</span>
                    </div>
                    <button
                      type="button"
                      className="cm-mini-btn"
                      onClick={() => setBrSelectedTables(brSelectedTables.length === brParsedTables.length ? [] : [...brParsedTables])}
                    >
                      {brSelectedTables.length === brParsedTables.length ? t('connection.brDeselectAll') : t('connection.brSelectAll')}
                    </button>
                  </div>
                  <div className="cm-table-picker">
                    {brParsedTables.map(tableName => {
                      const isChecked = brSelectedTables.includes(tableName);
                      return (
                        <label key={tableName} className="cm-check">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => setBrSelectedTables(isChecked ? brSelectedTables.filter(x => x !== tableName) : [...brSelectedTables, tableName])}
                          />
                          <span>{tableName}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Chạy lại dump lên database đã có bảng cùng tên -> MySQL báo 1050
                  "Table already exists" và huỷ cả lần phục hồi. Tuỳ chọn này xoá trước. */}
              {brFile && (
                <label className="cm-check" style={{ alignItems: 'flex-start' }}>
                  <input
                    type="checkbox"
                    checked={brOverwrite}
                    onChange={(e) => setBrOverwrite(e.target.checked)}
                  />
                  <span>
                    {t('connection.brOverwriteLabel')}
                    <span className="cm-hint" style={{ display: 'block' }}>
                      {t('connection.brOverwriteHint')}
                    </span>
                  </span>
                </label>
              )}

              {/* Cùng tuỳ chọn với popup Nhập — dùng chung key dịch để hai chỗ không mô tả
                  cùng một hành vi bằng hai lời khác nhau. */}
              {brFile && (
                <label className="cm-check" style={{ alignItems: 'flex-start' }}>
                  <input
                    type="checkbox"
                    checked={brContinueOnError}
                    onChange={(e) => setBrContinueOnError(e.target.checked)}
                  />
                  <span>
                    {t('importDialog.continueOnErrorLabel')}
                    <span className="cm-hint" style={{ display: 'block' }}>
                      {t('importDialog.continueOnErrorHint')}
                    </span>
                  </span>
                </label>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );

  return (
    <div className={`connection-manager-container ${isSuccessConnecting ? 'connecting-zoom-out' : ''}`} style={{ position: 'relative' }}>
      {isSuccessConnecting && (
        <div className="connection-success-overlay">
          <div className="connection-success-card">
            <div className="connection-success-icon-wrap">
              <Database size={32} className="connection-success-icon" />
              <CheckCircle2 size={16} className="connection-success-badge" />
            </div>
            <div className="connection-success-title">{t('connection.successTitle')}</div>
            <div className="connection-success-subtitle">
              <Trans
                i18nKey="connection.successSubtitle"
                values={{ name: connectingDbName }}
                components={{ strong: <strong /> }}
              />
            </div>
            <div className="connection-success-loader">
              <LoadingSpinner size={16} />
              <span>{t('connection.successLoading')}</span>
            </div>
          </div>
        </div>
      )}

      <div className="connection-card">
        <div className="cm-shell">
          {/* ————— Sidebar: danh sách kết nối đã lưu ————— */}
          <aside className="cm-side">
            <div className="cm-side-head">
              <span className="cm-side-title">{t('connection.sideTitle', { n: profiles.length })}</span>
              {/* Nhập/xuất tệp profile: quản lý cả bộ profile, không phải mở thêm một kết nối. */}
              {!embedded && (
                <>
                  <button className="cm-icon-btn" title={t('connection.importFromFile')} onClick={() => document.getElementById('cm-import-file')?.click()}>
                    <Upload size={13} />
                  </button>
                  <input id="cm-import-file" type="file" accept=".tableplusconnection,.tableforgeconnection,.json" onChange={handleFileImportSelect} className="cm-hidden-file" />
                  <button className="cm-icon-btn" title={t('connection.exportAll')} onClick={() => openExportModal('all')}>
                    <Download size={13} />
                  </button>
                </>
              )}
            </div>

            <div className="cm-new-wrap">
              <button className="cm-new-btn" onClick={() => setShowNewMenu((v) => !v)}>
                <Plus size={14} /> {t('connection.newConnection')}
                <ChevronDown size={13} style={{ opacity: 0.6, marginLeft: 'auto' }} />
              </button>
              {showNewMenu && (
                <>
                  <div className="cm-pop-backdrop" onClick={() => setShowNewMenu(false)} />
                  <div className="cm-pop">
                    {NEW_TYPES.map(nt => {
                      const m = TYPE_META[nt.val];
                      return (
                        <button
                          key={nt.val}
                          className="cm-pop-item"
                          onClick={() => { setShowNewMenu(false); handleCreateNewProfile(nt.val); }}
                        >
                          <span className={`cm-badge sm ${nt.val}`}><m.Icon size={13} /></span>
                          <span>{nt.label}</span>
                        </button>
                      );
                    })}
                    <div className="cm-pop-sep" />
                    <button className="cm-pop-item" onClick={() => { setShowNewMenu(false); setShowImportUrlModal(true); }}>
                      <span className="cm-badge sm ghost"><Link size={12} /></span>
                      <span>{t('connection.fromUrl')}</span>
                    </button>
                  </div>
                </>
              )}
            </div>

            <div className="cm-search">
              <Search size={14} className="cm-search-icon" />
              <input
                type="text"
                value={profileSearch}
                onChange={(e) => setProfileSearch(e.target.value)}
                placeholder={t('connection.searchPlaceholder')}
              />
              {profileSearch && (
                <button className="cm-icon-btn sm" onClick={() => setProfileSearch('')} title={t('connection.clearSearch')}>
                  <X size={12} />
                </button>
              )}
            </div>

            <div
              className="cm-list"
              onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, scope: 'all' }); }}
            >
              {groupNames.length === 0 && (
                <div className="cm-empty">
                  {profiles.length === 0
                    ? <Trans i18nKey="connection.emptyNoProfiles" components={{ strong: <b /> }} />
                    : t('connection.emptyNoMatch', { q: profileSearch })}
                </div>
              )}

              {groupNames.map(groupName => {
                const collapsed = !!collapsedGroups[groupName] && !_pq;
                return (
                  <div key={groupName} className="cm-group">
                    <button
                      className="cm-group-head"
                      onClick={() => toggleGroup(groupName)}
                      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setContextMenu({ x: e.clientX, y: e.clientY, scope: 'group', groupName }); }}
                    >
                      {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                      <span>{groupName}</span>
                      <span className="cm-group-count">{groupedProfiles[groupName].length}</span>
                    </button>

                    {!collapsed && groupedProfiles[groupName].map(p => {
                      const m = TYPE_META[p.type] || TYPE_META.sqlite;
                      const isActive = activeProfileId === p.id && !isBrMode;
                      const sqliteFile = p.config?.sqlitePath ? (p.config.sqlitePath.split(/[/\\]/).pop() || p.config.sqlitePath) : '';
                      const sub = p.config?.host
                        ? `${p.config.host}${p.config.database ? ' / ' + p.config.database : ''}`
                        : sqliteFile;
                      const fullSubInfo = p.config?.sqlitePath || sub;
                      // Đèn trạng thái: chỉ dòng đang được tác động mới có, và chỉ
                      // 'busy' được nháy. Màn hình này chỉ tồn tại khi chưa có kết
                      // nối nào mở, nên "đang mở" không phải trạng thái khả dụng —
                      // thay vào đó là đang kết nối/kiểm tra và kết quả kiểm tra.
                      const led: 'busy' | 'ok' | 'fail' | null = !isActive
                        ? null
                        : isBusy ? 'busy'
                          : testStatus === 'ok' ? 'ok'
                            : testStatus === 'fail' ? 'fail'
                              : null;
                      return (
                        <div
                          key={p.id}
                          className={`cm-item ${isActive ? 'active' : ''}`}
                          onClick={() => selectProfile(p)}
                          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setContextMenu({ x: e.clientX, y: e.clientY, scope: 'single', groupName, profile: p }); }}
                        >
                          <span
                            className={`cm-badge ${p.type}`}
                            style={p.color ? { background: p.color } : undefined}
                          >
                            <m.Icon size={16} />
                          </span>
                          <div className="cm-item-body">
                            <div className="cm-item-name">
                              <span className="cm-ellipsis">{p.name}</span>
                              {/* Đèn trạng thái: chỉ 'busy' nháy. */}
                              {led && <span className={`cm-item-led ${led}`} title={ledTitle[led]} />}
                              {defaultProfileId === p.id && <Star size={10} className="cm-default-star" aria-label={t('connection.defaultConnectionAria')} />}
                            </div>
                            <div className="cm-item-sub" title={fullSubInfo}>{m.label}{sub ? ` · ${sub}` : ''}</div>
                          </div>
                          <div className="cm-item-actions">
                            <button
                              className="cm-icon-btn sm"
                              onClick={(e) => handleToggleDefaultProfile(p.id, e)}
                              title={defaultProfileId === p.id ? t('connection.unsetDefault') : t('connection.setDefault')}
                            >
                              <Star size={12} className={defaultProfileId === p.id ? 'cm-star-active' : ''} />
                            </button>
                            <button className="cm-icon-btn sm" onClick={(e) => handleDuplicateProfile(p, e)} title={t('connection.duplicateProfile')}>
                              <Copy size={12} />
                            </button>
                            <button className="cm-icon-btn sm danger" onClick={(e) => handleDeleteProfile(p.id, e)} title={t('connection.deleteProfile')}>
                              <Trash2 size={12} />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>

            {/* Sao lưu & Phục hồi thao tác trên kết nối ĐANG MỞ, nên trong hộp thoại "thêm kết nối"
                nó vừa lệch việc vừa dễ hiểu sai là đang backup cái sắp mở. Ở workspace nó đã có chỗ
                riêng trên thanh tiêu đề. */}
            {!embedded && (
              <div className="cm-side-foot">
                <button
                  className={`cm-ghost-row ${isBrMode ? 'active' : ''}`}
                  onClick={() => setActiveType('backup_restore' as any)}
                >
                  <DatabaseBackup size={15} />
                  <span>{t('connection.backupRestore')}</span>
                </button>
              </div>
            )}
          </aside>

          {/* ————— Pane chính ————— */}
          <main className="cm-main">
            {isBrMode ? (
              <header className="cm-main-head">
                <button className="cm-icon-btn lg" title={t('connection.backToList')} onClick={() => setActiveType(((profiles.find(p => p.id === activeProfileId)?.type) || 'sqlite') as any)}>
                  <ArrowLeft size={16} />
                </button>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="cm-head-name">{t('connection.backupRestore')}</div>
                  <div className="cm-head-meta">{t('connection.brHeadMeta')}</div>
                </div>
              </header>
            ) : hasProfile ? (
              <>
                <header className="cm-main-head">
                  <div className="cm-head-info">
                    <div
                      className={`cm-avatar ${activeType}`}
                      style={profiles.find(p => p.id === activeProfileId)?.color ? { background: profiles.find(p => p.id === activeProfileId)?.color } : undefined}
                    >
                      <activeMeta.Icon size={22} />
                    </div>
                    <div className="cm-head-text">
                      <div className="cm-head-name">
                        <span className="cm-ellipsis">{profileNameInput || t('connection.defaultProfileName')}</span>
                      </div>
                      <div className="cm-head-meta">
                        <span>{activeMeta.label}</span>
                        {profileGroup && <span className="cm-chip">{profileGroup}</span>}
                        <span className={`cm-pill ${testStatus === 'ok' ? 'ok' : testStatus === 'fail' ? 'fail' : 'idle'}`}>
                          <i />
                          {testStatus === 'ok' ? t('connection.pillTested') : testStatus === 'fail' ? t('connection.pillFailed') : t('connection.pillUntested')}
                        </span>
                      </div>
                    </div>
                  </div>
                  <button className="cm-uri" onClick={handleCopyUri} title={t('connection.copyUri')}>
                    <span>{connectionUri}</span>
                    {uriCopied ? <Check size={12} style={{ flexShrink: 0, color: 'var(--st-ok)' }} /> : <Copy size={12} style={{ flexShrink: 0, opacity: 0.7 }} />}
                  </button>
                </header>

                {hasNetTabs && (
                  <nav className="cm-tabs">
                    <button className={`cm-tab ${formTab === 'general' ? 'active' : ''}`} onClick={() => setFormTab('general')}>
                      <Server size={13} /> {t('connection.tabGeneral')}
                      {authMethod === 'aws_iam' && isServerDb && <span className="cm-tab-dot" title={t('connection.tabDotAws')} />}
                    </button>
                    <button className={`cm-tab ${formTab === 'ssl' ? 'active' : ''}`} onClick={() => setFormTab('ssl')}>
                      <ShieldCheck size={13} /> SSL
                      {tlsOn && <span className="cm-tab-dot" title={t('connection.tabDotSsl', { mode: sslMode })} />}
                    </button>
                    <button className={`cm-tab ${formTab === 'ssh' ? 'active' : ''}`} onClick={() => setFormTab('ssh')}>
                      <Network size={13} /> SSH Tunnel
                      {sshEnabled && <span className="cm-tab-dot" title={t('connection.tabDotSsh')} />}
                    </button>
                  </nav>
                )}
              </>
            ) : null}

            <div className="cm-pane">
              <div className="cm-pane-inner">
                {errorMsg && (
                  <div className="cm-alert err">
                    <AlertTriangle size={15} style={{ flexShrink: 0 }} />
                    <span style={{ flex: 1 }}>{errorMsg}</span>
                    {/* Máy chủ bắt buộc SSL mà đang để DISABLED -> mở đường sửa ngay,
                        vì lỗi trả về từ driver khá khó hiểu với người mới. */}
                    {isServerDb && sslMode === 'DISABLED' && /ssl|no encryption|secure transport/i.test(errorMsg) && (
                      <button
                        className="cm-alert-btn"
                        onClick={() => { setSslMode('REQUIRED'); setFormTab('ssl'); setErrorMsg(null); }}
                      >
                        {t('connection.enableSsl')}
                      </button>
                    )}
                    <button className="cm-icon-btn sm" onClick={() => setErrorMsg(null)} title={t('common.close')}><X size={12} /></button>
                  </div>
                )}
                {successMsg && (
                  <div className="cm-alert ok">
                    <CheckCircle2 size={15} style={{ flexShrink: 0 }} />
                    <span style={{ flex: 1 }}>{successMsg}</span>
                    <button className="cm-icon-btn sm" onClick={() => setSuccessMsg(null)} title={t('common.close')}><X size={12} /></button>
                  </div>
                )}
                {/* Kho bí mật HĐH hỏng thì cấu hình vẫn lưu được nhưng mật khẩu thì không —
                    phải báo rõ, đừng để người dùng tưởng đã lưu xong. */}
                {secretError && (
                  <div className="cm-alert err">
                    <ShieldAlert size={15} style={{ flexShrink: 0 }} />
                    <span style={{ flex: 1 }}>{secretError}</span>
                    <button className="cm-icon-btn sm" onClick={() => setSecretError(null)} title={t('common.close')}><X size={12} /></button>
                  </div>
                )}

                {isBrMode
                  ? renderBackupRestore()
                  : !hasProfile
                    ? (
                      <div className="cm-blank">
                        <Database size={34} style={{ opacity: 0.35 }} />
                        <div className="cm-blank-title">{t('connection.blankTitle')}</div>
                        <div className="cm-hint">{t('connection.blankHint')}</div>
                      </div>
                    )
                    : formTab === 'ssl' && hasNetTabs
                      ? renderSslTab()
                      : formTab === 'ssh' && hasNetTabs
                        ? renderSshTab()
                        : renderGeneralTab()}
              </div>
            </div>

            <footer className="cm-foot">
              {isBrMode ? (
                <>
                  {brProgress ? (
                    <span className="cm-foot-msg" style={{ flex: 1, minWidth: 0, display: 'flex' }}>
                      <ProgressBar progress={brProgress} />
                    </span>
                  ) : (
                    <span className="cm-foot-msg cm-hint">
                      {brAction === 'restore' && brFile && brParsedTables.length > 0
                        ? t('connection.brFootSelected', { selected: brSelectedTables.length, total: brParsedTables.length })
                        : ''}
                    </span>
                  )}
                  <button
                    className="cm-btn primary"
                    onClick={handleBrClick}
                    disabled={brLoading || (brAction === 'restore' && (!brFile || (brParsedTables.length > 0 && brSelectedTables.length === 0)))}
                  >
                    {brLoading
                      ? <><LoadingSpinner size={13} /> {brAction === 'backup' ? t('connection.brBackingUp') : t('connection.brRestoring')}</>
                      : <>{brAction === 'backup'
                        ? <><Download size={14} /> {t('connection.brStartBackup')}</>
                        : <><Upload size={14} /> {t('connection.brStartRestore')}</>}</>}
                  </button>
                </>
              ) : hasProfile ? (
                <>
                  <button className="cm-btn" onClick={handleSaveProfile}>
                    <Save size={13} /> {t('connection.saveChanges')}
                  </button>
                  <span className="cm-foot-msg" />
                  <button className="cm-btn" onClick={handleTestConnection} disabled={isBusy}>
                    {isTesting ? <LoadingSpinner size={13} /> : <CheckCircle2 size={13} />} {t('connection.test')}
                  </button>
                  <button className="cm-btn primary" onClick={() => handleConnect(false)} disabled={isBusy}>
                    {isConnecting
                      ? <><LoadingSpinner size={13} /> {t('connection.connecting')}</>
                      : <><LogIn size={14} /> {t('connection.connect')}</>}
                  </button>
                </>
              ) : null}
            </footer>
          </main>
        </div>
      </div>

      {/* ————— Modal: nhập từ connection URL ————— */}
      {showImportUrlModal && (
        <div className="cm-modal-backdrop">
          <div className="cm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="cm-modal-head">
              <Link size={14} style={{ color: 'var(--win-accent)' }} />
              <h3>{t('connection.importUrlTitle')}</h3>
              <button className="cm-icon-btn" onClick={() => { setShowImportUrlModal(false); setImportUrlInput(''); }} title={t('common.close')}><X size={14} /></button>
            </div>
            <div className="form-group">
              <label>{t('connection.connectionUrl')}</label>
              <input
                type="text"
                className="form-input"
                value={importUrlInput}
                onChange={(e) => setImportUrlInput(e.target.value)}
                placeholder="postgresql://user:password@host:5432/database"
                onKeyDown={(e) => { if (e.key === 'Enter' && importUrlInput.trim()) handleImportUrlSubmit(); }}
                autoFocus
              />
              <span className="cm-hint">{t('connection.importUrlHint')}</span>
            </div>
            <div className="cm-modal-foot">
              <button className="cm-btn" onClick={() => { setShowImportUrlModal(false); setImportUrlInput(''); }}>{t('common.cancel')}</button>
              <button className="cm-btn primary" onClick={handleImportUrlSubmit} disabled={!importUrlInput.trim()}>{t('connection.importAction')}</button>
            </div>
          </div>
        </div>
      )}

      {/* ————— Context menu cho kết nối / nhóm ————— */}
      {contextMenu && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onClick={() => setContextMenu(null)} />
          <div className="cm-ctx" style={{ top: contextMenu.y, left: contextMenu.x }}>
            {contextMenu.scope === 'single' && contextMenu.profile && (
              <>
                <button className="context-menu-item" onClick={() => { handleToggleDefaultProfile(contextMenu.profile!.id); setContextMenu(null); }}>
                  <Star size={13} style={{ fill: defaultProfileId === contextMenu.profile.id ? 'var(--st-warn)' : 'none', color: 'var(--st-warn)', flexShrink: 0 }} />
                  <span>{defaultProfileId === contextMenu.profile.id ? t('connection.unsetDefault') : t('connection.setDefault')}</span>
                </button>
                <button className="context-menu-item" onClick={() => { handleDuplicateProfile(contextMenu.profile!, { stopPropagation: () => { } } as any); setContextMenu(null); }}>
                  <Copy size={13} style={{ flexShrink: 0 }} />
                  <span>{t('connection.duplicateProfile')}</span>
                </button>
                <button className="context-menu-item" onClick={async () => { const p = contextMenu.profile!; setContextMenu(null); /* SSH terminal cần mật khẩu/private key -> lấy từ kho HĐH */ setTerminalProfile({ ...p, config: await configWithSecrets(p) }); }}>
                  <TerminalSquare size={13} style={{ flexShrink: 0 }} />
                  <span>
                    {contextMenu.profile.config?.sshEnabled && contextMenu.profile.config?.sshHost
                      ? t('connection.ctxOpenSshTerminal')
                      : t('connection.ctxOpenLocalTerminal')}
                  </span>
                </button>
                <div className="cm-pop-sep" />
                <button className="context-menu-item" onClick={() => openExportModal('single', undefined, contextMenu.profile)}>
                  <Download size={13} style={{ flexShrink: 0 }} />
                  <span>{t('connection.ctxExportThis')}</span>
                </button>
              </>
            )}
            {(contextMenu.scope === 'group' || contextMenu.scope === 'single') && contextMenu.groupName && (
              <button className="context-menu-item" onClick={() => openExportModal('group', contextMenu.groupName)}>
                <Download size={13} style={{ flexShrink: 0 }} />
                <span>{t('connection.ctxExportGroup', { name: contextMenu.groupName })}</span>
              </button>
            )}
            <button className="context-menu-item" onClick={() => openExportModal('all')}>
              <Download size={13} style={{ flexShrink: 0 }} />
              <span>{t('connection.exportAll')}</span>
            </button>
          </div>
        </>
      )}

      {/* Terminal overlay (SSH nếu profile có SSH, ngược lại shell cục bộ) */}
      {terminalProfile && (
        <TerminalPanel
          connId={connId}
          config={terminalProfile.config as DbConnectionConfig}
          profileName={terminalProfile.name}
          floating
          onClose={() => setTerminalProfile(null)}
        />
      )}

      {/* ————— Modal: tuỳ chọn xuất kết nối ————— */}
      {showExportModal && (
        <div className="cm-modal-backdrop">
          <div className="cm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="cm-modal-head">
              <Download size={14} style={{ color: 'var(--win-accent)' }} />
              <h3>
                {exportScope === 'group' ? t('connection.exportModalGroup', { name: exportGroupTarget }) :
                  exportScope === 'single' ? t('connection.exportModalSingle', { name: exportSingleProfile?.name }) :
                    t('connection.exportAll')}
              </h3>
              <button className="cm-icon-btn" onClick={() => setShowExportModal(false)} title={t('common.close')} disabled={exporting}><X size={14} /></button>
            </div>

            <div className="cm-subcard">
              <label className="cm-check">
                <input type="checkbox" checked={exportIncludePasswords} onChange={(e) => setExportIncludePasswords(e.target.checked)} />
                <span style={{ fontWeight: 600 }}>{t('connection.exportIncludePasswords')}</span>
              </label>
              <div className={`cm-hint ${exportIncludePasswords ? 'warn' : ''}`} style={{ marginLeft: '24px', marginTop: '4px' }}>
                {exportIncludePasswords
                  ? t('connection.exportWarnIncluded')
                  : t('connection.exportWarnExcluded')}
              </div>
              <div className="form-group" style={{ marginTop: '14px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Lock size={11} /> {t('connection.exportFilePassword')}
                </label>
                <input
                  type="password"
                  className="form-input"
                  value={exportFilePassword}
                  onChange={(e) => setExportFilePassword(e.target.value)}
                  placeholder={t('connection.exportFilePasswordPlaceholder')}
                />
              </div>
            </div>

            <div className="cm-modal-foot">
              <button className="cm-btn" onClick={() => setShowExportModal(false)} disabled={exporting}>{t('common.cancel')}</button>
              {/* Wrapped in an arrow: passed directly, the MouseEvent lands in
                  `plainConfirmed` (truthy) and the plain-password warning is skipped. */}
              <button className="cm-btn primary" onClick={() => handlePerformExport()} disabled={exporting}>
                {exporting ? <LoadingSpinner size={12} /> : <Download size={13} />} {t('connection.exportAction')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ————— Modal: nhập mật khẩu giải mã tệp ————— */}
      {showImportPasswordModal && (
        <div className="cm-modal-backdrop">
          <div className="cm-modal sm" onClick={(e) => e.stopPropagation()}>
            <div className="cm-modal-head">
              <Lock size={14} style={{ color: 'var(--st-warn)' }} />
              <h3>{t('connection.importPwTitle')}</h3>
            </div>
            <p className="cm-hint" style={{ margin: 0 }}>
              {t('connection.importPwDesc')}
            </p>
            <div className="form-group">
              <label>{t('connection.importPwLabel')}</label>
              <input
                type="password"
                className="form-input"
                value={importPasswordInput}
                onChange={(e) => setImportPasswordInput(e.target.value)}
                placeholder={t('connection.importPwPlaceholder')}
                onKeyDown={(e) => { if (e.key === 'Enter') handlePasswordDecryptSubmit(); }}
                autoFocus
              />
            </div>
            <div className="cm-modal-foot">
              <button className="cm-btn" onClick={() => { setShowImportPasswordModal(false); setPendingImportContent(null); }} disabled={importing}>{t('common.cancel')}</button>
              <button className="cm-btn primary" onClick={handlePasswordDecryptSubmit} disabled={importing || !importPasswordInput.trim()}>
                {importing ? <LoadingSpinner size={12} /> : <Key size={13} />} {t('connection.importPwSubmit')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete profile. zIndex above the export/import modals (.cm-modal sets its own). */}
      <ConfirmDialog
        open={!!deleteProfileId}
        danger
        zIndex={1000000}
        title={t('connection.confirmDeleteProfileTitle')}
        message={t('connection.confirmDeleteProfile')}
        onConfirm={() => { const id = deleteProfileId; setDeleteProfileId(null); if (id) doDeleteProfile(id); }}
        onCancel={() => setDeleteProfileId(null)}
      />

      {/* Warning about exporting passwords in the clear — asked before reading the keychain. */}
      <ConfirmDialog
        open={confirmPlainExport}
        danger
        zIndex={1000000}
        title={t('connection.confirmExportPlainTitle')}
        message={t('connection.confirmExportPlainPasswords')}
        onConfirm={() => { setConfirmPlainExport(false); handlePerformExport(true); }}
        onCancel={() => setConfirmPlainExport(false)}
      />
    </div>
  );
};
