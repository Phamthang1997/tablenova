import React, { useState, useEffect, useRef } from 'react';
import { dbHelper } from '../utils/dbHelper';
import type { DbConnectionConfig } from '../utils/dbHelper';
import { Database, Server, CheckCircle2, AlertTriangle, Plus, Trash2, Save, Copy, Download, Upload, Lock, Key, TerminalSquare, Hash, FolderOpen, User, Link, Star, Eye, EyeOff, ShieldAlert, Search, X, ChevronDown, ChevronRight, RefreshCw, ShieldCheck, Network, ArrowLeft, Check, Cloud, HardDriveDownload } from 'lucide-react';
import { PostgresIcon, MySqlIcon, RedisIcon, SqliteIcon } from './DbIcons';
import { encryptConnectionExport, decryptConnectionExport } from '../utils/cryptoHelper';
import { TerminalPanel } from './TerminalPanel';

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
const EyeBtn: React.FC<{ on: boolean; onClick: () => void }> = ({ on, onClick }) => (
  <button type="button" className="cm-eye" onClick={onClick} title={on ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}>
    {on ? <EyeOff size={14} /> : <Eye size={14} />}
  </button>
);

// Nút chọn tệp (chứng chỉ SSL, private key...) — chỉ hiện tên tệp cho gọn.
const FilePick: React.FC<{ id: string; value: string; label: string; onPick: (path: string) => void }> = ({ id, value, label, onPick }) => (
  <>
    <input
      type="file"
      id={id}
      style={{ display: 'none' }}
      onChange={(e) => {
        const file = e.target.files?.[0];
        if (file) onPick((file as any).path || file.name);
      }}
    />
    <button type="button" className={`cm-file-btn ${value ? 'has-file' : ''}`} onClick={() => document.getElementById(id)?.click()} title={value || label}>
      <FolderOpen size={12} />
      <span>{value ? value.split(/[\\/]/).pop() : label}</span>
    </button>
  </>
);

export interface SavedProfile {
  id: string;
  name: string;
  type: 'sqlite' | 'postgres' | 'mysql' | 'redis';
  config: any;
  color?: string;
  group?: string;
  isDefault?: boolean;
}

interface ConnectionManagerProps {
  onConnect: (dbName: string, dbType: 'sqlite' | 'postgres' | 'mysql' | 'redis', color?: string, config?: DbConnectionConfig) => void;
}

// Giải thích từng mức SSL — hiển thị dưới ô select thay vì nhồi vào <option>
// (option dài sẽ bị mũi tên của select đè lên và popup native tràn ra ngoài).
const SSL_MODE_DESC: Record<string, string> = {
  DISABLED: 'Tắt hẳn TLS — mật khẩu và dữ liệu đi ở dạng thô. Máy chủ nào bắt buộc SSL sẽ từ chối kết nối.',
  PREFERRED: 'Có TLS thì dùng, không có thì vẫn kết nối thường — kẻ chặn đường truyền có thể ép tụt về không mã hoá.',
  REQUIRED: 'Bắt buộc TLS nhưng không kiểm tra chứng chỉ — chống nghe lén, chưa chống được máy chủ giả mạo.',
  VERIFY_CA: 'Bắt buộc TLS và chứng chỉ máy chủ phải do CA tin cậy ký — chống được máy chủ giả mạo.',
  VERIFY_IDENTITY: 'Như VERIFY_CA, thêm điều kiện hostname khớp chứng chỉ — mức an toàn cao nhất.',
};

// Meta hiển thị theo loại DB (badge + nhãn + màu) dùng cho sidebar và header.
// Nhãn cho đèn trạng thái ở mỗi dòng kết nối trong sidebar.
const LED_TITLE: Record<'busy' | 'ok' | 'fail', string> = {
  busy: 'Đang xử lý kết nối này...',
  ok: 'Kiểm tra kết nối thành công',
  fail: 'Kiểm tra kết nối thất bại',
};

// Logo thật của từng hệ DB (xem DbIcons.tsx) + màu thương hiệu cho ô nền.
const TYPE_META: Record<string, { label: string; color: string; Icon: React.FC<{ size?: number }> }> = {
  sqlite: { label: 'SQLite', color: '#003B57', Icon: SqliteIcon },
  postgres: { label: 'PostgreSQL', color: '#336791', Icon: PostgresIcon },
  mysql: { label: 'MySQL', color: '#00758F', Icon: MySqlIcon },
  redis: { label: 'Redis', color: '#DC382D', Icon: RedisIcon },
};

export const ConnectionManager: React.FC<ConnectionManagerProps> = ({ onConnect }) => {
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
  const [sqlitePath, setSqlitePath] = useState('demo.db');

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
  const [sslMode, setSslMode] = useState('DISABLED');
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

  const [loading, setLoading] = useState(false);
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
  const [brSqlitePath, setBrSqlitePath] = useState('demo.db');
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

  const [brFilename, setBrFilename] = useState('database_backup');
  const [brCompressGzip, setBrCompressGzip] = useState(false);
  const [brDropTable, setBrDropTable] = useState(true);
  const [brIncludeStructure, setBrIncludeStructure] = useState(true);
  const [brIncludeContent, setBrIncludeContent] = useState(true);
  const [brFile, setBrFile] = useState<File | null>(null);
  const [brLoading, setBrLoading] = useState(false);
  const [brParsedTables, setBrParsedTables] = useState<string[]>([]);
  const [brSelectedTables, setBrSelectedTables] = useState<string[]>([]);
  const [brParsing, setBrParsing] = useState(false);

  const [brSqlText, setBrSqlText] = useState<string>('');
  const [availableDatabases, setAvailableDatabases] = useState<string[]>([]);
  const [loadingDbs, setLoadingDbs] = useState(false);

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
        setErrorMsg(res.error || 'Không thể tải danh sách database');
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

            const tables: string[] = [];
            const re = /(?:CREATE\s+TABLE|INSERT\s+INTO|DROP\s+TABLE\s+IF\s+EXISTS)\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?([a-zA-Z0-9_]+)[`"']?/gi;
            let match;
            while ((match = re.exec(text)) !== null) {
              const table = match[1];
              if (!tables.includes(table)) {
                tables.push(table);
              }
            }
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
  const [profileGroup, setProfileGroup] = useState('');

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

  const openExportModal = (scope: 'all' | 'group' | 'single', groupName?: string, profile?: SavedProfile) => {
    setExportScope(scope);
    setExportGroupTarget(groupName || '');
    setExportSingleProfile(profile || null);
    setExportIncludePasswords(false);
    setExportFilePassword('');
    setShowExportModal(true);
    setContextMenu(null);
  };

  const handlePerformExport = async () => {
    setExporting(true);
    try {
      let targetProfiles: SavedProfile[] = [];
      if (exportScope === 'all') {
        targetProfiles = [...profiles];
      } else if (exportScope === 'group') {
        targetProfiles = profiles.filter(p => (p.group?.trim() || 'MẶC ĐỊNH') === exportGroupTarget);
      } else if (exportScope === 'single' && exportSingleProfile) {
        targetProfiles = [exportSingleProfile];
      }

      if (targetProfiles.length === 0) {
        alert("Không có kết nối nào để xuất.");
        setExporting(false);
        return;
      }

      // Strip password fields if includePasswords is false
      const processedProfiles = targetProfiles.map(p => {
        const cloned = JSON.parse(JSON.stringify(p));
        if (!exportIncludePasswords && cloned.config) {
          delete cloned.config.password;
          delete cloned.config.pgPassword;
          delete cloned.config.myPassword;
          delete cloned.config.sshPassword;
          delete cloned.config.sshPassphrase;
          delete cloned.config.awsSecretAccessKey;
          delete cloned.config.awsSessionToken;
        }
        return cloned;
      });

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
      setSuccessMsg(`Đã xuất ${processedProfiles.length} kết nối thành công!`);
    } catch (e: any) {
      alert("Lỗi xuất kết nối: " + e.message);
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
          alert('Lỗi nhập kết nối: ' + err.message);
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
        throw new Error('Tệp không chứa thông tin kết nối hợp lệ.');
      }

      // Merge into existing profiles without duplicate IDs
      const existingIds = new Set(profiles.map(p => p.id));
      const merged = [...profiles];
      let importedCount = 0;

      for (const item of newProfilesToImport) {
        if (!item.name || !item.type || !item.config) continue;
        let itemToSave = { ...item };
        if (existingIds.has(itemToSave.id)) {
          itemToSave.id = 'profile_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
        }
        merged.push(itemToSave);
        existingIds.add(itemToSave.id);
        importedCount++;
      }

      setProfiles(merged);
      localStorage.setItem('tf_connection_profiles', JSON.stringify(merged));
      setShowImportPasswordModal(false);
      setPendingImportContent(null);
      setSuccessMsg(`Đã nhập thành công ${importedCount} kết nối!`);
    } catch (e: any) {
      if (e.requiresPassword) {
        throw e;
      }
      alert('Lỗi nhập kết nối: ' + e.message);
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
        alert('Lỗi giải mã: ' + err.message);
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
        throw new Error("Giao thức URL không hỗ trợ (chỉ nhận postgres:// hoặc mysql://)");
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
      alert('Lỗi định dạng URL: ' + e.message);
      return null;
    }
  };

  const handleImportUrlSubmit = () => {
    const res = parseConnectionUrl(importUrlInput);
    if (!res) return;

    const newId = 'profile_' + Date.now();
    const newProfile: SavedProfile = {
      id: newId,
      name: `Imported ${res.type.toUpperCase()} (${res.config.host || res.config.sqlitePath || 'DB'})`,
      type: res.type,
      config: res.config
    };

    const newProfiles = [...profiles, newProfile];
    setProfiles(newProfiles);
    localStorage.setItem('tf_connection_profiles', JSON.stringify(newProfiles));
    selectProfile(newProfile);

    setShowImportUrlModal(false);
    setImportUrlInput('');
    setSuccessMsg('Đã nhập thành công cấu hình kết nối từ URL!');
  };


  // Load saved connection configurations from localStorage
  useEffect(() => {
    const saved = localStorage.getItem('tf_connection_profiles');
    const savedDefaultId = localStorage.getItem('tf_default_profile_id');
    if (saved) {
      try {
        const parsed: SavedProfile[] = JSON.parse(saved);
        setProfiles(parsed);
        if (parsed.length > 0) {
          const defaultProf = parsed.find(p => p.id === savedDefaultId) || parsed[0];
          selectProfile(defaultProf);
        }
      } catch { }
    } else {
      const defaultProfiles: SavedProfile[] = [
        {
          id: 'demo',
          name: 'Demo Database',
          type: 'sqlite',
          config: { type: 'sqlite', sqlitePath: 'demo.db' }
        }
      ];
      setProfiles(defaultProfiles);
      localStorage.setItem('tf_connection_profiles', JSON.stringify(defaultProfiles));
      selectProfile(defaultProfiles[0]);
    }
  }, []);

  const selectProfile = (profile: SavedProfile) => {
    setActiveProfileId(profile.id);
    setActiveType(profile.type);
    setTestStatus('untested');
    setFormTab('general');
    setErrorMsg(null);
    setSuccessMsg(null);
    setProfileNameInput(profile.name);
    setProfileColor(profile.color || '');
    setProfileGroup(profile.group || '');

    const config = profile.config;
    if (profile.type === 'sqlite') {
      setSqlitePath(config.sqlitePath || 'demo.db');
    } else if (profile.type === 'redis') {
      setRedisHost(config.host || '127.0.0.1');
      setRedisPort(config.port || 6379);
      setRedisUser(config.user || '');
      setRedisPassword(config.password || '');
      setRedisDbIndex(config.dbIndex ?? 0);
      setSslEnabled(config.sslEnabled || false);
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

  const handleSaveProfile = () => {
    if (!activeProfileId) return;
    const targetName = profileNameInput.trim() || 'Kết nối mới';

    let config: any = {};
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
        return { ...p, name: targetName, type: activeType as any, config, color: profileColor, group: profileGroup };
      }
      return p;
    });

    setProfiles(updatedProfiles);
    localStorage.setItem('tf_connection_profiles', JSON.stringify(updatedProfiles));
    setSuccessMsg('Đã lưu cấu hình kết nối!');
  };

  const handleCreateNewProfile = (type: 'sqlite' | 'postgres' | 'mysql' | 'redis') => {
    const newId = 'profile_' + Date.now();
    const newProfile: SavedProfile = {
      id: newId,
      name: `Kết nối ${type.toUpperCase()}`,
      type,
      config: type === 'sqlite'
        ? { type, sqlitePath: 'new_database.db' }
        : type === 'postgres'
          ? { type, host: 'localhost', port: 5432, user: 'postgres', database: 'postgres' }
          : type === 'redis'
            ? { type, host: '127.0.0.1', port: 6379, user: '', password: '', dbIndex: 0 }
            : { type, host: 'localhost', port: 3306, user: 'root', database: '' }
    };

    const newProfiles = [...profiles, newProfile];
    setProfiles(newProfiles);
    localStorage.setItem('tf_connection_profiles', JSON.stringify(newProfiles));
    selectProfile(newProfile);
  };

  const handleDeleteProfile = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (id === 'demo') {
      alert('Không thể xóa kết nối demo.');
      return;
    }
    if (!confirm('Bạn có chắc chắn muốn xóa cấu hình kết nối này?')) return;

    const newProfiles = profiles.filter(p => p.id !== id);
    setProfiles(newProfiles);
    localStorage.setItem('tf_connection_profiles', JSON.stringify(newProfiles));

    if (activeProfileId === id) {
      if (newProfiles.length > 0) {
        selectProfile(newProfiles[0]);
      } else {
        setActiveProfileId(null);
      }
    }
  };

  const handleDuplicateProfile = (profile: SavedProfile, e: React.MouseEvent) => {
    e.stopPropagation();
    const newId = 'profile_' + Date.now();
    const duplicated: SavedProfile = {
      ...profile,
      id: newId,
      name: `${profile.name} (Copy)`
    };
    const newProfiles = [...profiles, duplicated];
    setProfiles(newProfiles);
    localStorage.setItem('tf_connection_profiles', JSON.stringify(newProfiles));
    selectProfile(duplicated);
  };

  const handleConnect = async (isDemo = false) => {
    setLoading(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    let config: DbConnectionConfig;

    if (isDemo) {
      config = { type: 'sqlite', sqlitePath: 'demo.db' };
    } else if (activeType === 'sqlite') {
      config = { type: 'sqlite', sqlitePath };
      localStorage.setItem('tf_sqlite_path', sqlitePath);
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
      localStorage.setItem('tf_pg_config', JSON.stringify({ host: pgHost, port: pgPort, user: pgUser, database: pgDatabase }));
      localStorage.setItem('tf_ssh_config', JSON.stringify({
        sshEnabled,
        sshHost,
        sshPort,
        sshUser,
        sshAuthType,
        sshKeyPath,
        sshKeyContent,
        sshPassphrase
      }));
    } else if (activeType === 'redis') {
      config = {
        type: 'redis',
        host: redisHost,
        port: redisPort,
        user: redisUser,
        password: redisPassword,
        dbIndex: redisDbIndex,
        sslEnabled,
      };
      localStorage.setItem('tf_redis_config', JSON.stringify({ host: redisHost, port: redisPort, user: redisUser, dbIndex: redisDbIndex }));
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
      localStorage.setItem('tf_my_config', JSON.stringify({ host: myHost, port: myPort, user: myUser, database: myDatabase }));
      localStorage.setItem('tf_ssh_config', JSON.stringify({
        sshEnabled,
        sshHost,
        sshPort,
        sshUser,
        sshAuthType,
        sshKeyPath,
        sshKeyContent,
        sshPassphrase
      }));
    }

    localStorage.setItem('tf_last_type', isDemo ? 'sqlite' : activeType);

    const res = await dbHelper.connect(config);

    setLoading(false);
    if (res.success) {
      setSuccessMsg(res.message);
      setIsSuccessConnecting(true);
      setConnectingDbName(res.database || (config.type === 'sqlite' ? config.sqlitePath : config.database) || 'Database');
      const activeProfile = profiles.find(p => p.id === activeProfileId);
      setTimeout(() => {
        onConnect(res.database || 'Database', config.type, activeProfile?.color, config);
      }, 480);
    } else {
      setErrorMsg(res.message);
    }
  };

  const handleTestConnection = async () => {
    setLoading(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    // Redis: test bằng chính redis_connect (PING) qua dbHelper.connect.
    if (activeType === 'redis') {
      const res = await dbHelper.connect({
        type: 'redis', host: redisHost, port: redisPort, user: redisUser,
        password: redisPassword, dbIndex: redisDbIndex, sslEnabled,
      });
      setLoading(false);
      setTestStatus(res.success ? 'ok' : 'fail');
      if (res.success) setSuccessMsg('Kết nối Redis OK (PING thành công).');
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
    setLoading(false);
    setTestStatus(res.success ? 'ok' : 'fail');
    if (res.success) {
      setSuccessMsg('Kiểm tra kết nối thành công!');
      await dbHelper.disconnect();
    } else {
      setErrorMsg(res.message);
    }
  };

  const handleBrSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
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

    try {
      const connRes = await dbHelper.connect(config);
      if (!connRes.success) {
        throw new Error(`Kết nối thất bại: ${connRes.message}`);
      }

      if (brAction === 'backup') {
        const list = await dbHelper.getTables();
        const tables = list.map(t => t.name);
        if (tables.length === 0) {
          throw new Error('Cơ sở dữ liệu không có bảng nào để sao lưu.');
        }

        const res = await dbHelper.exportMultiTables({
          format: 'sql',
          tables,
          filename: brFilename,
          sqlOptions: {
            dropTable: brDropTable,
            includeStructure: brIncludeStructure,
            includeContent: brIncludeContent
          },
          compressGzip: brCompressGzip
        });

        if (res.success) {
          setSuccessMsg(`Sao lưu cơ sở dữ liệu thành công!`);
        } else {
          throw new Error(res.error || 'Lỗi sao lưu cơ sở dữ liệu.');
        }
      } else {
        if (!brFile || !brSqlText) {
          throw new Error('Vui lòng chọn tệp sao lưu (.sql hoặc .sql.gz) để khôi phục.');
        }

        const resData = await dbHelper.restoreBackup(brSqlText, brSelectedTables);
        if (resData.success) {
          setSuccessMsg(`Khôi phục thành công! Đã chạy ${resData.statementsCount || 0} câu lệnh SQL.`);
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
          throw new Error(resData.error || 'Lỗi khôi phục cơ sở dữ liệu.');
        }
      }
    } catch (err: any) {
      setErrorMsg(err.message);
    } finally {
      await dbHelper.disconnect();
      setBrLoading(false);
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
    const groupName = p.group?.trim() || 'MẶC ĐỊNH';
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
  const activeMeta = TYPE_META[activeType] || TYPE_META.sqlite;
  const hasProfile = !!activeProfileId && !isBrMode;

  // Connection string tóm tắt (không kèm mật khẩu) — hiển thị ở header để đối chiếu nhanh.
  const connectionUri = (() => {
    if (activeType === 'sqlite') return `sqlite://${sqlitePath}`;
    if (activeType === 'redis') return `${sslEnabled ? 'rediss' : 'redis'}://${redisUser ? redisUser + '@' : ''}${redisHost}:${redisPort}/${redisDbIndex}`;
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
        <label>Cơ sở dữ liệu</label>
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
            title="Tải lại danh sách database"
            onClick={() => fetchDatabases(fetchTarget)}
            disabled={loadingDbs}
          >
            {loadingDbs ? <LoadingSpinner size={12} /> : <RefreshCw size={13} />}
          </button>
          <button
            type="button"
            className={`cm-combo-btn ${showDbList ? 'on' : ''}`}
            title="Chọn từ danh sách"
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
                      ? 'Đang tải danh sách...'
                      : availableDatabases.length ? 'Không có database nào khớp' : 'Chưa tải được danh sách'}
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
      <div className="cm-section-title">Thông tin cơ bản</div>
      {/* Tên + nhóm gộp trên một dòng: header phía trên đã hiển thị lại những
          thông tin này nên không cần mô tả dài dòng ở đây. */}
      <div className="cm-grid basic" style={{ marginTop: '12px' }}>
        <div className="form-group">
          <label>Tên kết nối</label>
          <input
            type="text"
            className="form-input"
            value={profileNameInput}
            onChange={(e) => setProfileNameInput(e.target.value)}
            placeholder="VD: Fleet Staging"
          />
        </div>
        <div className="form-group">
          <label>Nhóm</label>
          {/* Combobox tự dựng thay cho <datalist>: native datalist hiện thêm một
              mũi tên riêng và popup không theo được theme của app. */}
          <div className="cm-combo">
            <input
              type="text"
              className="form-input"
              value={profileGroup}
              onChange={(e) => setProfileGroup(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') setShowGroupList(false); }}
              placeholder={existingGroups.length ? 'Chọn hoặc nhập...' : 'STG, PROD...'}
            />
            {existingGroups.length > 0 && (
              <button
                type="button"
                className={`cm-combo-btn ${showGroupList ? 'on' : ''}`}
                title="Chọn nhóm đã có"
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
                        <span>Bỏ nhóm</span>
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  // ——— Cảnh báo kết nối từ xa nhưng chưa bật mã hoá ———
  const renderSslWarning = () => {
    if (activeType === 'redis') {
      if (sslEnabled || !isRemoteHost(redisHost)) return null;
      return (
        <div className="cm-warn">
          <ShieldAlert size={15} style={{ flexShrink: 0 }} />
          <span style={{ flex: 1 }}>Redis <b>từ xa</b> nhưng TLS đang tắt — dữ liệu truyền không mã hoá (server phải hỗ trợ <b>rediss://</b>).</span>
          <button type="button" className="cm-warn-btn" onClick={() => setSslEnabled(true)}>Bật TLS</button>
        </div>
      );
    }
    if (!isServerDb) return null;
    const host = activeType === 'postgres' ? pgHost : myHost;
    if (sslMode !== 'DISABLED' || !isRemoteHost(host)) return null;
    return (
      <div className="cm-warn">
        <ShieldAlert size={15} style={{ flexShrink: 0 }} />
        <span style={{ flex: 1 }}>Máy chủ <b>từ xa</b> nhưng SSL đang <b>DISABLED</b> — mật khẩu và dữ liệu truyền đi không được mã hoá.</span>
        <button type="button" className="cm-warn-btn" onClick={() => { setSslMode('REQUIRED'); setFormTab('ssl'); }}>Bật SSL</button>
      </div>
    );
  };

  // ——— Tab "Chung" cho từng loại DB ———
  const renderGeneralTab = () => (
    <>
      {renderBasicSection()}

      {activeType === 'sqlite' && (
        <div className="cm-section">
          <div className="cm-section-title">Tệp cơ sở dữ liệu</div>
          <div className="cm-section-desc">SQLite lưu toàn bộ dữ liệu trong một tệp duy nhất trên máy bạn.</div>
          <div className="cm-fields">
            <div className="form-group">
              <label>Đường dẫn tệp (.db, .sqlite)</label>
              <div className="input-icon-wrapper">
                <input
                  type="text"
                  className="form-input"
                  value={sqlitePath}
                  onChange={(e) => setSqlitePath(e.target.value)}
                  placeholder="my_database.db"
                />
                <FolderOpen size={14} className="input-icon" />
              </div>
              <span className="cm-hint">Nếu tệp chưa tồn tại, TableNova sẽ tự tạo tệp mới khi kết nối.</span>
            </div>
          </div>
        </div>
      )}

      {activeType === 'redis' && (
        <div className="cm-section">
          <div className="cm-section-title">Máy chủ Redis</div>
          <div className="cm-section-desc">Thông tin đăng nhập được lưu cục bộ trên thiết bị của bạn.</div>
          <div className="cm-fields">
            <div className="cm-grid host">
              <div className="form-group">
                <label>Host</label>
                <div className="input-icon-wrapper">
                  <input type="text" className="form-input" value={redisHost} onChange={(e) => setRedisHost(e.target.value)} placeholder="127.0.0.1" />
                  <Server size={14} className="input-icon" />
                </div>
              </div>
              <div className="form-group">
                <label>Port</label>
                <div className="input-icon-wrapper">
                  <input type="number" className="form-input" value={redisPort} onChange={(e) => setRedisPort(parseInt(e.target.value) || 6379)} />
                  <Hash size={14} className="input-icon" />
                </div>
              </div>
            </div>
            <div className="cm-grid two">
              <div className="form-group">
                <label>Username (ACL — bỏ trống nếu không dùng)</label>
                <div className="input-icon-wrapper">
                  <input type="text" className="form-input" value={redisUser} onChange={(e) => setRedisUser(e.target.value)} placeholder="default" />
                  <User size={14} className="input-icon" />
                </div>
              </div>
              <div className="form-group">
                <label>Mật khẩu</label>
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
                <label>Database index (0–15)</label>
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
            <div className="cm-switch-row">
              <button type="button" className={`cm-switch ${sslEnabled ? 'on' : ''}`} onClick={() => setSslEnabled(!sslEnabled)} aria-label="Bật TLS" />
              <div style={{ flex: 1 }}>
                <div className="cm-switch-label">Mã hoá TLS (rediss://)</div>
                <div className="cm-hint">Bắt buộc với Redis Cloud, ElastiCache in-transit encryption và hầu hết Redis từ xa.</div>
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
              <div className="cm-section-title">Máy chủ</div>
              <div className="cm-section-desc">Địa chỉ máy chủ và cổng kết nối tới {activeMeta.label}.</div>
              <div className="cm-fields">
                <div className="cm-grid host">
                  <div className="form-group">
                    <label>Host</label>
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
                    <label>Port</label>
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
                  activeType === 'postgres' ? 'postgres' : 'Không bắt buộc',
                )}
                {renderSslWarning()}
              </div>
            </div>

            <div className="cm-section">
              <div className="cm-label-row">
                <div>
                  <div className="cm-section-title">Xác thực</div>
                  <div className="cm-section-desc">Đăng nhập bằng mật khẩu hoặc token AWS IAM (RDS/Aurora).</div>
                </div>
                <div className="cm-seg">
                  <button type="button" className={authMethod === 'password' ? 'on' : ''} onClick={() => setAuthMethod('password')}>Mật khẩu</button>
                  <button type="button" className={authMethod === 'aws_iam' ? 'on' : ''} onClick={() => setAuthMethod('aws_iam')}>AWS IAM</button>
                </div>
              </div>
              <div className="cm-fields">
                <div className="cm-grid two">
                  <div className="form-group">
                    <label>{authMethod === 'aws_iam' ? 'DB user (đã bật IAM auth)' : 'Tên đăng nhập'}</label>
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
                      <label>Mật khẩu</label>
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
                      <span>AWS IAM authentication</span>
                    </div>
                    <div className="cm-hint" style={{ marginBottom: '12px' }}>
                      TableNova sinh token IAM (hiệu lực 15 phút) thay cho mật khẩu và tự ép SSL <b>REQUIRED</b>.
                    </div>
                    <div className="cm-seg" style={{ marginBottom: '12px' }}>
                      <button type="button" className={awsAuthType === 'access_key' ? 'on' : ''} onClick={() => setAwsAuthType('access_key')}>Access Key</button>
                      <button type="button" className={awsAuthType === 'profile' ? 'on' : ''} onClick={() => setAwsAuthType('profile')}>Profile (~/.aws)</button>
                    </div>
                    <div className="cm-fields" style={{ marginTop: 0 }}>
                      {awsAuthType === 'access_key' ? (
                        <>
                          <div className="form-group">
                            <label>Access Key ID</label>
                            <input type="text" className="form-input" value={awsAccessKeyId} onChange={(e) => setAwsAccessKeyId(e.target.value)} placeholder="AKIA..." autoComplete="off" />
                          </div>
                          <div className="cm-grid two">
                            <div className="form-group">
                              <label>Secret Access Key</label>
                              <div className="input-icon-wrapper">
                                <input type={showPw ? 'text' : 'password'} className="form-input" value={awsSecretAccessKey} onChange={(e) => setAwsSecretAccessKey(e.target.value)} autoComplete="off" style={{ paddingRight: '32px', paddingLeft: '10px' }} />
                                <EyeBtn on={showPw} onClick={() => setShowPw((v) => !v)} />
                              </div>
                            </div>
                            <div className="form-group">
                              <label>Session Token (tuỳ chọn)</label>
                              <div className="input-icon-wrapper">
                                <input type={showPw ? 'text' : 'password'} className="form-input" value={awsSessionToken} onChange={(e) => setAwsSessionToken(e.target.value)} autoComplete="off" style={{ paddingRight: '32px', paddingLeft: '10px' }} />
                                <EyeBtn on={showPw} onClick={() => setShowPw((v) => !v)} />
                              </div>
                            </div>
                          </div>
                        </>
                      ) : (
                        <div className="form-group">
                          <label>Tên profile</label>
                          <input type="text" className="form-input" value={awsProfile} onChange={(e) => setAwsProfile(e.target.value)} placeholder="default" autoComplete="off" />
                        </div>
                      )}
                      <div className="form-group">
                        <label>AWS Region</label>
                        <input type="text" className="form-input" value={awsRegion} onChange={(e) => setAwsRegion(e.target.value)} placeholder="Bỏ trống = tự dò từ host RDS" autoComplete="off" />
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

  // ——— Tab "SSL" (Postgres / MySQL) ———
  const renderSslTab = () => {
    const prefix = activeType === 'postgres' ? 'pg' : 'my';
    const sslOn = sslMode !== 'DISABLED';
    // Hai mode VERIFY_* mới thực sự kiểm tra chứng chỉ máy chủ -> CA cert lúc đó
    // là bắt buộc (nếu CA không nằm trong store của hệ thống). REQUIRED thì 3 ô
    // này chỉ phục vụ mTLS.
    const needVerify = sslMode === 'VERIFY_CA' || sslMode === 'VERIFY_IDENTITY';
    return (
      <div className="cm-section">
        <div className="cm-section-title">Mã hoá đường truyền (SSL/TLS)</div>
        <div className="cm-section-desc">Chọn mức độ yêu cầu mã hoá. Với máy chủ trên Internet nên dùng ít nhất <b>REQUIRED</b>.</div>
        <div className="cm-fields">
          <div className="form-group">
            <label>SSL mode</label>
            <select className="form-input" value={sslMode} onChange={(e) => setSslMode(e.target.value)} style={{ maxWidth: '240px' }}>
              {Object.keys(SSL_MODE_DESC).map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            <span className="cm-hint">{SSL_MODE_DESC[sslMode] || ''}</span>
          </div>

          {renderSslWarning()}

          {sslOn && (
            <div className="cm-subcard">
              <div className="cm-label-row" style={{ marginBottom: '12px' }}>
                <div className="cm-subcard-head" style={{ margin: 0 }}>
                  <ShieldCheck size={13} />
                  <span>{needVerify ? 'Chứng chỉ' : 'Chứng chỉ (tuỳ chọn)'}</span>
                </div>
                <button
                  type="button"
                  className="cm-mini-btn"
                  onClick={() => { setSslKeyPath(''); setSslCertPath(''); setSslCaPath(''); }}
                  disabled={!sslKeyPath && !sslCertPath && !sslCaPath}
                >
                  <X size={10} /> <span>Xoá tất cả</span>
                </button>
              </div>
              <div className="cm-grid three">
                <div className="form-group">
                  <label>Client key</label>
                  <FilePick id={`${prefix}-ssl-key-picker`} value={sslKeyPath} label="Chọn key..." onPick={setSslKeyPath} />
                </div>
                <div className="form-group">
                  <label>Client cert</label>
                  <FilePick id={`${prefix}-ssl-cert-picker`} value={sslCertPath} label="Chọn cert..." onPick={setSslCertPath} />
                </div>
                <div className="form-group">
                  <label>CA cert{needVerify ? ' *' : ''}</label>
                  <FilePick id={`${prefix}-ssl-ca-picker`} value={sslCaPath} label="Chọn CA..." onPick={setSslCaPath} />
                </div>
              </div>
              <div className="cm-hint" style={{ marginTop: '10px' }}>
                <b>Client key + cert</b> chỉ cần khi máy chủ bắt client tự xác thực (mTLS) — không liên quan tới việc kiểm tra máy chủ.{' '}
                {needVerify ? (
                  <><b>CA cert</b> cần điền nếu CA của máy chủ không nằm trong store chứng chỉ hệ thống; thiếu thì kết nối sẽ bị từ chối.</>
                ) : activeType === 'postgres' ? (
                  <>Riêng Postgres: nếu điền <b>CA cert</b> thì REQUIRED sẽ tự kiểm tra chứng chỉ như VERIFY_CA.</>
                ) : (
                  <>REQUIRED không kiểm tra chứng chỉ máy chủ, nên <b>CA cert</b> ở đây không có tác dụng.</>
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
      <div className="cm-section-title">SSH Tunnel</div>
      <div className="cm-section-desc">Kết nối qua một máy chủ trung gian (bastion/jump host) khi cơ sở dữ liệu không mở ra ngoài.</div>
      <div className="cm-fields">
        <div className="cm-switch-row">
          <button type="button" className={`cm-switch ${sshEnabled ? 'on' : ''}`} onClick={() => setSshEnabled(!sshEnabled)} aria-label="Bật SSH tunnel" />
          <div style={{ flex: 1 }}>
            <div className="cm-switch-label">Kết nối qua SSH</div>
            <div className="cm-hint">Host/port của cơ sở dữ liệu sẽ được truy cập từ phía máy chủ SSH.</div>
          </div>
        </div>

        {sshEnabled && (
          <>
            <div className="cm-grid host">
              <div className="form-group">
                <label>SSH host</label>
                <div className="input-icon-wrapper">
                  <input type="text" className="form-input" value={sshHost} onChange={(e) => setSshHost(e.target.value)} placeholder="bastion.example.com" />
                  <Network size={14} className="input-icon" />
                </div>
              </div>
              <div className="form-group">
                <label>SSH port</label>
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
              <span className="cm-subhead">Xác thực SSH</span>
              <div className="cm-seg">
                <button type="button" className={sshAuthType === 'password' ? 'on' : ''} onClick={() => setSshAuthType('password')}>Mật khẩu</button>
                <button type="button" className={sshAuthType === 'key' ? 'on' : ''} onClick={() => setSshAuthType('key')}>Private key</button>
              </div>
            </div>

            <div className="cm-grid two">
              <div className="form-group">
                <label>SSH user</label>
                <div className="input-icon-wrapper">
                  <input type="text" className="form-input" value={sshUser} onChange={(e) => setSshUser(e.target.value)} placeholder="ubuntu" />
                  <User size={14} className="input-icon" />
                </div>
              </div>
              {sshAuthType === 'password' ? (
                <div className="form-group">
                  <label>Mật khẩu SSH</label>
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
                  <label>Passphrase (nếu key có mật khẩu)</label>
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
                  <span>Private key</span>
                </div>
                <div className="cm-fields" style={{ marginTop: 0 }}>
                  <div className="form-group">
                    <label>Đường dẫn tệp key</label>
                    <div className="cm-file-row">
                      <input
                        type="text"
                        className="form-input"
                        value={sshKeyPath}
                        onChange={(e) => setSshKeyPath(e.target.value)}
                        placeholder="C:\Users\me\.ssh\id_rsa"
                      />
                      <FilePick id="ssh-key-file-picker" value="" label="Chọn tệp..." onPick={setSshKeyPath} />
                    </div>
                  </div>
                  <div className="form-group">
                    <label>Hoặc dán trực tiếp nội dung key</label>
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

  // ——— Chế độ Sao lưu & Phục hồi (không cần kết nối sẵn) ———
  const renderBackupRestore = () => (
    <>
      <div className="cm-section">
        <div className="cm-label-row">
          <div>
            <div className="cm-section-title">{brAction === 'backup' ? 'Sao lưu cơ sở dữ liệu' : 'Phục hồi từ tệp sao lưu'}</div>
            <div className="cm-section-desc">
              {brAction === 'backup'
                ? 'Xuất toàn bộ cấu trúc và dữ liệu ra tệp .sql (có thể nén gzip).'
                : 'Chạy lại tệp .sql / .sql.gz vào cơ sở dữ liệu đích, chọn được từng bảng.'}
            </div>
          </div>
          <div className="cm-seg">
            <button type="button" className={brAction === 'backup' ? 'on' : ''} onClick={() => setBrAction('backup')}>Sao lưu</button>
            <button type="button" className={brAction === 'restore' ? 'on' : ''} onClick={() => setBrAction('restore')}>Phục hồi</button>
          </div>
        </div>

        <div className="cm-fields">
          <div className="cm-grid two">
            <div className="form-group">
              <label>Lấy cấu hình từ kết nối đã lưu</label>
              <select
                className="form-input"
                value={selectedBrProfileId || ''}
                onChange={(e) => {
                  const profId = e.target.value;
                  setSelectedBrProfileId(profId);
                  const selectedProf = profiles.find(p => p.id === profId);
                  if (selectedProf) {
                    setBrType(selectedProf.type === 'redis' ? 'sqlite' : selectedProf.type);
                    const c = selectedProf.config;
                    if (selectedProf.type === 'sqlite') {
                      setBrSqlitePath(c.sqlitePath || 'demo.db');
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
                <option value="">— Nhập thủ công —</option>
                {profiles.map(p => (
                  <option key={p.id} value={p.id}>{p.name} ({p.type.toUpperCase()})</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label>Loại cơ sở dữ liệu</label>
              <select className="form-input" value={brType} onChange={(e) => setBrType(e.target.value as any)}>
                <option value="sqlite">SQLite</option>
                <option value="postgres">PostgreSQL</option>
                <option value="mysql">MySQL</option>
              </select>
            </div>
          </div>

          {brType === 'sqlite' ? (
            <div className="form-group">
              <label>Đường dẫn tệp SQLite</label>
              <div className="input-icon-wrapper">
                <input type="text" className="form-input" value={brSqlitePath} onChange={(e) => setBrSqlitePath(e.target.value)} />
                <FolderOpen size={14} className="input-icon" />
              </div>
            </div>
          ) : (
            <>
              <div className="cm-grid host">
                <div className="form-group">
                  <label>Host</label>
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
                  <label>Port</label>
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
                  <label>Tên đăng nhập</label>
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
                  <label>Mật khẩu</label>
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
                brType === 'postgres' ? 'postgres' : 'Không bắt buộc',
              )}
            </>
          )}
        </div>
      </div>

      <div className="cm-section">
        {brAction === 'backup' ? (
          <>
            <div className="cm-section-title">Tuỳ chọn xuất</div>
            <div className="cm-fields">
              <div className="form-group" style={{ maxWidth: '340px' }}>
                <label>Tên tệp sao lưu</label>
                <input type="text" className="form-input" value={brFilename} onChange={(e) => setBrFilename(e.target.value)} />
              </div>
              <div className="cm-check-grid">
                <label className="cm-check"><input type="checkbox" checked={brDropTable} onChange={(e) => setBrDropTable(e.target.checked)} /><span>DROP TABLE IF EXISTS</span></label>
                <label className="cm-check"><input type="checkbox" checked={brIncludeStructure} onChange={(e) => setBrIncludeStructure(e.target.checked)} /><span>Kèm cấu trúc bảng</span></label>
                <label className="cm-check"><input type="checkbox" checked={brIncludeContent} onChange={(e) => setBrIncludeContent(e.target.checked)} /><span>Kèm dữ liệu</span></label>
                <label className="cm-check"><input type="checkbox" checked={brCompressGzip} onChange={(e) => setBrCompressGzip(e.target.checked)} /><span>Nén gzip (.sql.gz)</span></label>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="cm-section-title">Tệp sao lưu</div>
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
                  <div className="cm-dropzone-title">{brFile ? brFile.name : 'Chọn tệp .sql hoặc .sql.gz'}</div>
                  <div className="cm-hint">{brFile ? `${(brFile.size / 1024 / 1024).toFixed(2)} MB — bấm để đổi tệp` : 'Bấm để chọn tệp từ máy của bạn'}</div>
                </div>
              </label>

              {brParsing && (
                <div className="cm-hint" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <LoadingSpinner size={11} /> Đang đọc danh sách bảng từ tệp...
                </div>
              )}

              {brParsedTables.length > 0 && (
                <div className="cm-subcard">
                  <div className="cm-label-row" style={{ marginBottom: '10px' }}>
                    <div className="cm-subcard-head" style={{ margin: 0 }}>
                      <Database size={13} />
                      <span>Bảng sẽ phục hồi ({brSelectedTables.length}/{brParsedTables.length})</span>
                    </div>
                    <button
                      type="button"
                      className="cm-mini-btn"
                      onClick={() => setBrSelectedTables(brSelectedTables.length === brParsedTables.length ? [] : [...brParsedTables])}
                    >
                      {brSelectedTables.length === brParsedTables.length ? 'Bỏ chọn tất cả' : 'Chọn tất cả'}
                    </button>
                  </div>
                  <div className="cm-table-picker">
                    {brParsedTables.map(t => {
                      const isChecked = brSelectedTables.includes(t);
                      return (
                        <label key={t} className="cm-check">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => setBrSelectedTables(isChecked ? brSelectedTables.filter(x => x !== t) : [...brSelectedTables, t])}
                          />
                          <span>{t}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
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
            <div className="connection-success-title">Kết nối thành công!</div>
            <div className="connection-success-subtitle">
              Đang chuẩn bị workspace cho <strong>{connectingDbName}</strong>...
            </div>
            <div className="connection-success-loader">
              <LoadingSpinner size={16} />
              <span>Đang mở giao diện CSDL...</span>
            </div>
          </div>
        </div>
      )}

      <div className="connection-card">
        <div className="cm-shell">
          {/* ————— Sidebar: danh sách kết nối đã lưu ————— */}
          <aside className="cm-side">
            <div className="cm-side-head">
              <span className="cm-side-title">Kết nối · {profiles.length}</span>
              <button className="cm-icon-btn" title="Nhập từ tệp cấu hình" onClick={() => document.getElementById('cm-import-file')?.click()}>
                <Upload size={13} />
              </button>
              <input id="cm-import-file" type="file" accept=".tableplusconnection,.tableforgeconnection,.json" onChange={handleFileImportSelect} style={{ display: 'none' }} />
              <button className="cm-icon-btn" title="Xuất tất cả kết nối" onClick={() => openExportModal('all')}>
                <Download size={13} />
              </button>
            </div>

            <div className="cm-new-wrap">
              <button className="cm-new-btn" onClick={() => setShowNewMenu((v) => !v)}>
                <Plus size={14} /> Kết nối mới
                <ChevronDown size={13} style={{ opacity: 0.6, marginLeft: 'auto' }} />
              </button>
              {showNewMenu && (
                <>
                  <div className="cm-pop-backdrop" onClick={() => setShowNewMenu(false)} />
                  <div className="cm-pop">
                    {NEW_TYPES.map(t => {
                      const m = TYPE_META[t.val];
                      return (
                        <button
                          key={t.val}
                          className="cm-pop-item"
                          onClick={() => { setShowNewMenu(false); handleCreateNewProfile(t.val); }}
                        >
                          <span className="cm-badge sm" style={{ background: m.color }}><m.Icon size={13} /></span>
                          <span>{t.label}</span>
                        </button>
                      );
                    })}
                    <div className="cm-pop-sep" />
                    <button className="cm-pop-item" onClick={() => { setShowNewMenu(false); setShowImportUrlModal(true); }}>
                      <span className="cm-badge sm ghost"><Link size={12} /></span>
                      <span>Từ connection URL...</span>
                    </button>
                  </div>
                </>
              )}
            </div>

            <div className="cm-search">
              <Search size={13} style={{ color: 'var(--win-text-disabled)', flexShrink: 0 }} />
              <input
                type="text"
                value={profileSearch}
                onChange={(e) => setProfileSearch(e.target.value)}
                placeholder="Tìm theo tên, host, database..."
              />
              {profileSearch && (
                <button className="cm-icon-btn sm" onClick={() => setProfileSearch('')} title="Xoá tìm kiếm">
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
                    ? <>Chưa có kết nối nào.<br />Bấm <b>Kết nối mới</b> để bắt đầu.</>
                    : <>Không có kết nối nào khớp<br />với “{profileSearch}”.</>}
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
                      const sub = p.config?.host
                        ? `${p.config.host}${p.config.database ? ' / ' + p.config.database : ''}`
                        : (p.config?.sqlitePath || '');
                      // Đèn trạng thái: chỉ dòng đang được tác động mới có, và chỉ
                      // 'busy' được nháy. Màn hình này chỉ tồn tại khi chưa có kết
                      // nối nào mở, nên "đang mở" không phải trạng thái khả dụng —
                      // thay vào đó là đang kết nối/kiểm tra và kết quả kiểm tra.
                      const led: 'busy' | 'ok' | 'fail' | null = !isActive
                        ? null
                        : loading ? 'busy'
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
                          <span className="cm-badge" style={{ background: m.color }}><m.Icon size={15} /></span>
                          <div className="cm-item-body">
                            <div className="cm-item-name">
                              <span className="cm-ellipsis">{p.name}</span>
                              {/* Đèn trạng thái: chỉ 'busy' nháy. */}
                              {led && <span className={`cm-item-led ${led}`} title={LED_TITLE[led]} />}
                              {defaultProfileId === p.id && <Star size={10} style={{ fill: 'var(--st-warn)', color: 'var(--st-warn)', flexShrink: 0 }} aria-label="Kết nối mặc định" />}
                            </div>
                            <div className="cm-item-sub">{m.label}{sub ? ` · ${sub}` : ''}</div>
                          </div>
                          <div className="cm-item-actions">
                            <button
                              className="cm-icon-btn sm"
                              onClick={(e) => handleToggleDefaultProfile(p.id, e)}
                              title={defaultProfileId === p.id ? 'Bỏ kết nối mặc định' : 'Đặt làm kết nối mặc định'}
                            >
                              {/* fill đặt qua CSS chứ không qua prop: prop thành thuộc
                                  tính SVG, mà thuộc tính SVG không nhận var(). */}
                              <Star size={12} style={{ fill: defaultProfileId === p.id ? 'var(--st-warn)' : 'none', color: defaultProfileId === p.id ? 'var(--st-warn)' : 'currentColor' }} />
                            </button>
                            <button className="cm-icon-btn sm" onClick={(e) => handleDuplicateProfile(p, e)} title="Nhân bản kết nối">
                              <Copy size={12} />
                            </button>
                            {p.id !== 'demo' && (
                              <button className="cm-icon-btn sm danger" onClick={(e) => handleDeleteProfile(p.id, e)} title="Xoá kết nối">
                                <Trash2 size={12} />
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>

            <div className="cm-side-foot">
              <button
                className={`cm-ghost-row ${isBrMode ? 'active' : ''}`}
                onClick={() => setActiveType('backup_restore' as any)}
              >
                <HardDriveDownload size={14} />
                <span>Sao lưu &amp; Phục hồi</span>
              </button>
            </div>
          </aside>

          {/* ————— Pane chính ————— */}
          <main className="cm-main">
            {isBrMode ? (
              <header className="cm-main-head">
                <button className="cm-icon-btn lg" title="Quay lại danh sách kết nối" onClick={() => setActiveType(((profiles.find(p => p.id === activeProfileId)?.type) || 'sqlite') as any)}>
                  <ArrowLeft size={16} />
                </button>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="cm-head-name">Sao lưu &amp; Phục hồi</div>
                  <div className="cm-head-meta">Không cần mở kết nối trước — chỉ cần thông tin máy chủ.</div>
                </div>
              </header>
            ) : hasProfile ? (
              <>
                <header className="cm-main-head">
                  <div className="cm-avatar" style={{ background: activeMeta.color }}>
                    <activeMeta.Icon size={22} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="cm-head-name">
                      <span className="cm-ellipsis">{profileNameInput || 'Kết nối mới'}</span>
                    </div>
                    <div className="cm-head-meta">
                      <span>{activeMeta.label}</span>
                      {profileGroup && <span className="cm-chip">{profileGroup}</span>}
                      <span className={`cm-pill ${testStatus === 'ok' ? 'ok' : testStatus === 'fail' ? 'fail' : 'idle'}`}>
                        <i />
                        {testStatus === 'ok' ? 'Đã kiểm tra' : testStatus === 'fail' ? 'Kiểm tra thất bại' : 'Chưa kiểm tra'}
                      </span>
                    </div>
                  </div>
                  <button className="cm-uri" onClick={handleCopyUri} title="Sao chép connection string (không kèm mật khẩu)">
                    <span>{connectionUri}</span>
                    {uriCopied ? <Check size={12} style={{ flexShrink: 0, color: 'var(--st-ok)' }} /> : <Copy size={12} style={{ flexShrink: 0, opacity: 0.7 }} />}
                  </button>
                </header>

                {isServerDb && (
                  <nav className="cm-tabs">
                    <button className={`cm-tab ${formTab === 'general' ? 'active' : ''}`} onClick={() => setFormTab('general')}>
                      <Server size={13} /> Chung
                      {authMethod === 'aws_iam' && <span className="cm-tab-dot" title="Đang dùng AWS IAM" />}
                    </button>
                    <button className={`cm-tab ${formTab === 'ssl' ? 'active' : ''}`} onClick={() => setFormTab('ssl')}>
                      <ShieldCheck size={13} /> SSL
                      {sslMode !== 'DISABLED' && <span className="cm-tab-dot" title={`SSL: ${sslMode}`} />}
                    </button>
                    <button className={`cm-tab ${formTab === 'ssh' ? 'active' : ''}`} onClick={() => setFormTab('ssh')}>
                      <Network size={13} /> SSH Tunnel
                      {sshEnabled && <span className="cm-tab-dot" title="SSH tunnel đang bật" />}
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
                        Bật SSL
                      </button>
                    )}
                    <button className="cm-icon-btn sm" onClick={() => setErrorMsg(null)} title="Đóng"><X size={12} /></button>
                  </div>
                )}
                {successMsg && (
                  <div className="cm-alert ok">
                    <CheckCircle2 size={15} style={{ flexShrink: 0 }} />
                    <span style={{ flex: 1 }}>{successMsg}</span>
                    <button className="cm-icon-btn sm" onClick={() => setSuccessMsg(null)} title="Đóng"><X size={12} /></button>
                  </div>
                )}

                {isBrMode
                  ? renderBackupRestore()
                  : !hasProfile
                    ? (
                      <div className="cm-blank">
                        <Database size={34} style={{ opacity: 0.35 }} />
                        <div className="cm-blank-title">Chưa chọn kết nối</div>
                        <div className="cm-hint">Chọn một kết nối ở cột bên trái, hoặc tạo kết nối mới để bắt đầu.</div>
                      </div>
                    )
                    : formTab === 'ssl' && isServerDb
                      ? renderSslTab()
                      : formTab === 'ssh' && isServerDb
                        ? renderSshTab()
                        : renderGeneralTab()}
              </div>
            </div>

            <footer className="cm-foot">
              {isBrMode ? (
                <>
                  <span className="cm-foot-msg cm-hint">
                    {brAction === 'restore' && brFile && brParsedTables.length > 0
                      ? `${brSelectedTables.length}/${brParsedTables.length} bảng được chọn`
                      : ''}
                  </span>
                  <button
                    className="cm-btn primary"
                    onClick={handleBrSubmit}
                    disabled={brLoading || (brAction === 'restore' && (!brFile || (brParsedTables.length > 0 && brSelectedTables.length === 0)))}
                  >
                    {brLoading
                      ? <><LoadingSpinner size={13} /> {brAction === 'backup' ? 'Đang sao lưu...' : 'Đang phục hồi...'}</>
                      : <>{brAction === 'backup' ? <><Download size={14} /> Bắt đầu sao lưu</> : <><Upload size={14} /> Bắt đầu phục hồi</>}</>}
                  </button>
                </>
              ) : hasProfile ? (
                <>
                  <button className="cm-btn" onClick={handleSaveProfile}>
                    <Save size={13} /> Lưu thay đổi
                  </button>
                  <span className="cm-foot-msg" />
                  <button className="cm-btn" onClick={handleTestConnection} disabled={loading}>
                    {loading ? <LoadingSpinner size={13} /> : <CheckCircle2 size={13} />} Kiểm tra
                  </button>
                  <button className="cm-btn primary" onClick={() => handleConnect(false)} disabled={loading}>
                    {loading ? <><LoadingSpinner size={13} /> Đang kết nối...</> : <><Server size={14} /> Kết nối</>}
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
              <Link size={16} style={{ color: 'var(--win-accent)' }} />
              <h3>Nhập từ connection URL</h3>
              <button className="cm-icon-btn" onClick={() => { setShowImportUrlModal(false); setImportUrlInput(''); }} title="Đóng"><X size={14} /></button>
            </div>
            <div className="form-group">
              <label>Connection URL</label>
              <input
                type="text"
                className="form-input"
                value={importUrlInput}
                onChange={(e) => setImportUrlInput(e.target.value)}
                placeholder="postgresql://user:password@host:5432/database"
                onKeyDown={(e) => { if (e.key === 'Enter' && importUrlInput.trim()) handleImportUrlSubmit(); }}
                autoFocus
              />
              <span className="cm-hint">Hỗ trợ <code>postgres://</code>, <code>postgresql://</code>, <code>mysql://</code> và <code>sqlite://</code>.</span>
            </div>
            <div className="cm-modal-foot">
              <button className="cm-btn" onClick={() => { setShowImportUrlModal(false); setImportUrlInput(''); }}>Huỷ</button>
              <button className="cm-btn primary" onClick={handleImportUrlSubmit} disabled={!importUrlInput.trim()}>Nhập</button>
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
                  <span>{defaultProfileId === contextMenu.profile.id ? 'Bỏ kết nối mặc định' : 'Đặt làm kết nối mặc định'}</span>
                </button>
                <button className="context-menu-item" onClick={() => { handleDuplicateProfile(contextMenu.profile!, { stopPropagation: () => { } } as any); setContextMenu(null); }}>
                  <Copy size={13} style={{ flexShrink: 0 }} />
                  <span>Nhân bản kết nối</span>
                </button>
                <button className="context-menu-item" onClick={() => { setTerminalProfile(contextMenu.profile!); setContextMenu(null); }}>
                  <TerminalSquare size={13} style={{ flexShrink: 0 }} />
                  <span>
                    {contextMenu.profile.config?.sshEnabled && contextMenu.profile.config?.sshHost
                      ? 'Mở SSH Terminal'
                      : 'Mở Terminal (local)'}
                  </span>
                </button>
                <div className="cm-pop-sep" />
                <button className="context-menu-item" onClick={() => openExportModal('single', undefined, contextMenu.profile)}>
                  <Download size={13} style={{ flexShrink: 0 }} />
                  <span>Xuất kết nối này</span>
                </button>
              </>
            )}
            {(contextMenu.scope === 'group' || contextMenu.scope === 'single') && contextMenu.groupName && (
              <button className="context-menu-item" onClick={() => openExportModal('group', contextMenu.groupName)}>
                <Download size={13} style={{ flexShrink: 0 }} />
                <span>Xuất nhóm "{contextMenu.groupName}"</span>
              </button>
            )}
            <button className="context-menu-item" onClick={() => openExportModal('all')}>
              <Download size={13} style={{ flexShrink: 0 }} />
              <span>Xuất tất cả kết nối</span>
            </button>
          </div>
        </>
      )}

      {/* Terminal overlay (SSH nếu profile có SSH, ngược lại shell cục bộ) */}
      {terminalProfile && (
        <TerminalPanel
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
              <Download size={16} style={{ color: 'var(--win-accent)' }} />
              <h3>
                {exportScope === 'group' ? `Xuất nhóm "${exportGroupTarget}"` :
                  exportScope === 'single' ? `Xuất "${exportSingleProfile?.name}"` :
                    'Xuất tất cả kết nối'}
              </h3>
              <button className="cm-icon-btn" onClick={() => setShowExportModal(false)} title="Đóng" disabled={exporting}><X size={14} /></button>
            </div>

            <div className="cm-subcard">
              <label className="cm-check">
                <input type="checkbox" checked={exportIncludePasswords} onChange={(e) => setExportIncludePasswords(e.target.checked)} />
                <span style={{ fontWeight: 600 }}>Kèm mật khẩu database / SSH</span>
              </label>
              <div className={`cm-hint ${exportIncludePasswords ? 'warn' : ''}`} style={{ marginLeft: '24px', marginTop: '4px' }}>
                {exportIncludePasswords
                  ? '⚠ Mật khẩu sẽ nằm trong tệp xuất — nên đặt mật khẩu bảo vệ tệp bên dưới.'
                  : '✓ Mật khẩu sẽ bị loại khỏi tệp xuất.'}
              </div>
              <div className="form-group" style={{ marginTop: '14px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Lock size={11} /> Mật khẩu bảo vệ tệp (tuỳ chọn)
                </label>
                <input
                  type="password"
                  className="form-input"
                  value={exportFilePassword}
                  onChange={(e) => setExportFilePassword(e.target.value)}
                  placeholder="Để trống nếu không đặt mật khẩu"
                />
              </div>
            </div>

            <div className="cm-modal-foot">
              <button className="cm-btn" onClick={() => setShowExportModal(false)} disabled={exporting}>Huỷ</button>
              <button className="cm-btn primary" onClick={handlePerformExport} disabled={exporting}>
                {exporting ? <LoadingSpinner size={12} /> : <Download size={13} />} Xuất
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
              <Lock size={16} style={{ color: 'var(--st-warn)' }} />
              <h3>Tệp kết nối được mã hoá</h3>
            </div>
            <p className="cm-hint" style={{ margin: 0 }}>
              Nhập mật khẩu đã dùng khi xuất tệp để tiếp tục nhập kết nối.
            </p>
            <div className="form-group">
              <label>Mật khẩu tệp</label>
              <input
                type="password"
                className="form-input"
                value={importPasswordInput}
                onChange={(e) => setImportPasswordInput(e.target.value)}
                placeholder="Nhập mật khẩu..."
                onKeyDown={(e) => { if (e.key === 'Enter') handlePasswordDecryptSubmit(); }}
                autoFocus
              />
            </div>
            <div className="cm-modal-foot">
              <button className="cm-btn" onClick={() => { setShowImportPasswordModal(false); setPendingImportContent(null); }} disabled={importing}>Huỷ</button>
              <button className="cm-btn primary" onClick={handlePasswordDecryptSubmit} disabled={importing || !importPasswordInput.trim()}>
                {importing ? <LoadingSpinner size={12} /> : <Key size={13} />} Giải mã &amp; nhập
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
