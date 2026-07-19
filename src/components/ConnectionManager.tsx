import React, { useState, useEffect } from 'react';
import { dbHelper } from '../utils/dbHelper';
import type { DbConnectionConfig } from '../utils/dbHelper';
import { Database, Server, CheckCircle2, AlertTriangle, Plus, Trash2, Save, Copy, Download, Upload, Lock, Key, TerminalSquare } from 'lucide-react';
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

export interface SavedProfile {
  id: string;
  name: string;
  type: 'sqlite' | 'postgres' | 'mysql';
  config: any;
  color?: string;
  group?: string;
}

interface ConnectionManagerProps {
  onConnect: (dbName: string, dbType: 'sqlite' | 'postgres' | 'mysql', color?: string, config?: DbConnectionConfig) => void;
}

export const ConnectionManager: React.FC<ConnectionManagerProps> = ({ onConnect }) => {
  const [activeType, setActiveType] = useState<'sqlite' | 'postgres' | 'mysql' | 'backup_restore'>('sqlite');
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
      };
    } else if (type === 'mysql') {
      config = {
        type: 'mysql',
        host: myHost,
        port: myPort,
        user: myUser,
        password: myPassword,
        database: myDatabase,
      };
    } else if (type === 'br_postgres') {
      config = {
        type: 'postgres',
        host: brPgHost,
        port: brPgPort,
        user: brPgUser,
        password: brPgPassword,
        database: brPgDatabase,
      };
    } else {
      config = {
        type: 'mysql',
        host: brMyHost,
        port: brMyPort,
        user: brMyUser,
        password: brMyPassword,
        database: brMyDatabase,
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

  // Auto-load databases for Postgres
  useEffect(() => {
    if (activeType !== 'postgres') return;
    if (!pgHost.trim() || !pgUser.trim()) return;

    const timer = setTimeout(() => {
      fetchDatabases('postgres');
    }, 500);

    return () => clearTimeout(timer);
  }, [pgHost, pgPort, pgUser, pgPassword, activeType]);

  // Auto-load databases for MySQL
  useEffect(() => {
    if (activeType !== 'mysql') return;
    if (!myHost.trim() || !myUser.trim()) return;

    const timer = setTimeout(() => {
      fetchDatabases('mysql');
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
        fetchDatabases('br_postgres');
      }, 500);
      return () => clearTimeout(timer);
    } else {
      if (!brMyHost.trim() || !brMyUser.trim()) return;
      const timer = setTimeout(() => {
        fetchDatabases('br_mysql');
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
  const [selectedBrProfileId, setSelectedBrProfileId] = useState<string | null>(null);
  const [profileNameInput, setProfileNameInput] = useState('');
  const [profileColor, setProfileColor] = useState('');
  const [profileGroup, setProfileGroup] = useState('');

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
      setTimeout(() => setSuccessMsg(null), 4000);
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
      setTimeout(() => setSuccessMsg(null), 4000);
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
    setTimeout(() => setSuccessMsg(null), 3000);
  };


  // Load saved connection configurations from localStorage
  useEffect(() => {
    const saved = localStorage.getItem('tf_connection_profiles');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setProfiles(parsed);
        if (parsed.length > 0) {
          selectProfile(parsed[0]);
        }
      } catch {}
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
    setProfileNameInput(profile.name);
    setProfileColor(profile.color || '');
    setProfileGroup(profile.group || '');
    
    const config = profile.config;
    if (profile.type === 'sqlite') {
      setSqlitePath(config.sqlitePath || 'demo.db');
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

  const handleCreateNewProfile = (type: 'sqlite' | 'postgres' | 'mysql') => {
    const newId = 'profile_' + Date.now();
    const newProfile: SavedProfile = {
      id: newId,
      name: `Kết nối ${type.toUpperCase()}`,
      type,
      config: type === 'sqlite' 
        ? { type, sqlitePath: 'new_database.db' }
        : type === 'postgres'
          ? { type, host: 'localhost', port: 5432, user: 'postgres', database: 'postgres' }
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
      const activeProfile = profiles.find(p => p.id === activeProfileId);
      setTimeout(() => {
        onConnect(res.database || 'Database', config.type, activeProfile?.color, config);
      }, 800);
    } else {
      setErrorMsg(res.message);
    }
  };

  const handleTestConnection = async () => {
    setLoading(true);
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
        database: brPgDatabase
      };
    } else {
      config = {
        type: 'mysql',
        host: brMyHost,
        port: brMyPort,
        user: brMyUser,
        password: brMyPassword,
        database: brMyDatabase
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

  const groupedProfiles = profiles.reduce((acc, p) => {
    const groupName = p.group?.trim() || 'MẶC ĐỊNH';
    if (!acc[groupName]) acc[groupName] = [];
    acc[groupName].push(p);
    return acc;
  }, {} as Record<string, SavedProfile[]>);

  return (
    <div className="connection-manager-container">
      <div className="connection-card">
        <div className="connection-header">
          <h2>Kết nối cơ sở dữ liệu</h2>
          <p>Chọn loại cơ sở dữ liệu và nhập cấu hình kết nối để bắt đầu làm việc</p>
        </div>

        <div className="connection-body">
          <div className="connection-sidebar" style={{ display: 'flex', flexDirection: 'column', width: '220px', borderRight: '1px solid var(--win-border)', background: 'var(--win-bg-tab-bar, rgba(0,0,0,0.03))' }}>
            <div 
              style={{ padding: '8px', fontSize: '10px', fontWeight: 600, color: 'var(--win-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY, scope: 'all' });
              }}
            >
              <span>Kết nối đã lưu</span>
              <div style={{ display: 'flex', gap: '4px' }}>
                <button
                  onClick={() => openExportModal('all')}
                  style={{ background: 'none', border: 'none', color: 'var(--win-text-secondary)', cursor: 'pointer', padding: '2px', display: 'flex', alignItems: 'center' }}
                  title="Xuất tất cả kết nối (Export All Connections)"
                >
                  <Download size={11} />
                </button>
              </div>
            </div>
            
            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px', padding: '0 4px' }}>
              {Object.keys(groupedProfiles).map(groupName => (
                <div key={groupName} style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  <div 
                    style={{ padding: '6px 8px 2px 8px', fontSize: '9px', fontWeight: 700, color: 'var(--win-text-secondary)', opacity: 0.8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setContextMenu({ x: e.clientX, y: e.clientY, scope: 'group', groupName });
                    }}
                  >
                    <span>{groupName}</span>
                    <button
                      onClick={() => openExportModal('group', groupName)}
                      style={{ background: 'none', border: 'none', color: 'var(--win-text-secondary)', cursor: 'pointer', padding: '1px', display: 'flex', alignItems: 'center', opacity: 0.7 }}
                      title={`Xuất tất cả kết nối thuộc nhóm ${groupName}`}
                    >
                      <Download size={10} />
                    </button>
                  </div>
                  {groupedProfiles[groupName].map(p => (
                    <div
                      key={p.id}
                      onClick={() => selectProfile(p)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setContextMenu({ x: e.clientX, y: e.clientY, scope: 'single', groupName, profile: p });
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '6px 8px',
                        borderRadius: '4px',
                        background: activeProfileId === p.id && activeType !== 'backup_restore' ? 'var(--win-accent-alpha, rgba(0, 120, 215, 0.15))' : 'transparent',
                        borderLeft: activeProfileId === p.id && activeType !== 'backup_restore' ? `3px solid ${p.color || 'var(--win-accent)'}` : '3px solid transparent',
                        cursor: 'pointer',
                        fontSize: '11px',
                        color: 'var(--win-text-primary)'
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {p.type === 'sqlite' ? <Database size={12} className="icon-sqlite" /> : p.type === 'postgres' ? <Server size={12} className="icon-postgres" /> : <Database size={12} className="icon-mysql" />}
                        {p.color && (
                          <span style={{
                            display: 'inline-block',
                            width: '6px',
                            height: '6px',
                            borderRadius: '50%',
                            background: p.color,
                            marginRight: '2px'
                          }} />
                        )}
                        <span style={{ fontWeight: activeProfileId === p.id ? 600 : 400 }}>{p.name}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <Copy
                          size={11}
                          onClick={(e) => handleDuplicateProfile(p, e)}
                          style={{ color: 'var(--win-text-secondary)', opacity: 0.6, cursor: 'pointer' }}
                        />
                        {p.id !== 'demo' && (
                          <Trash2
                            size={11}
                            onClick={(e) => handleDeleteProfile(p.id, e)}
                            style={{ color: 'var(--win-text-secondary)', opacity: 0.6, cursor: 'pointer' }}
                            onMouseEnter={(e) => e.currentTarget.style.color = '#ef4444'}
                            onMouseLeave={(e) => e.currentTarget.style.color = 'var(--win-text-secondary)'}
                          />
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', padding: '8px', borderTop: '1px solid var(--win-border)' }}>
              <div style={{ display: 'flex', gap: '4px' }}>
                <button onClick={() => handleCreateNewProfile('sqlite')} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', padding: '6px', fontSize: '9px', border: '1px solid var(--win-border)', borderRadius: '4px', background: 'var(--win-bg-card)', cursor: 'pointer', color: 'var(--win-text-primary)' }} title="Tạo SQLite">
                  <Plus size={10} /> SQLite
                </button>
                <button onClick={() => handleCreateNewProfile('postgres')} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', padding: '6px', fontSize: '9px', border: '1px solid var(--win-border)', borderRadius: '4px', background: 'var(--win-bg-card)', cursor: 'pointer', color: 'var(--win-text-primary)' }} title="Tạo PostgreSQL">
                  <Plus size={10} /> PG
                </button>
                <button onClick={() => handleCreateNewProfile('mysql')} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', padding: '6px', fontSize: '9px', border: '1px solid var(--win-border)', borderRadius: '4px', background: 'var(--win-bg-card)', cursor: 'pointer', color: 'var(--win-text-primary)' }} title="Tạo MySQL">
                  <Plus size={10} /> MySQL
                </button>
              </div>
              
              <div style={{ display: 'flex', gap: '4px' }}>
                <button 
                  onClick={() => openExportModal('all')} 
                  style={{ 
                    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', padding: '5px', fontSize: '9px', 
                    border: '1px solid var(--win-border)', borderRadius: '4px', background: 'var(--win-bg-card)', 
                    cursor: 'pointer', color: 'var(--win-text-primary)'
                  }} 
                  title="Xuất các kết nối thành tệp (.tableplusconnection)"
                >
                  <Download size={10} /> Xuất (Export)
                </button>
                <label 
                  style={{ 
                    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', padding: '5px', fontSize: '9px', 
                    border: '1px solid var(--win-border)', borderRadius: '4px', background: 'var(--win-bg-card)', 
                    cursor: 'pointer', color: 'var(--win-text-primary)'
                  }} 
                  title="Nhập kết nối từ tệp (.tableplusconnection)"
                >
                  <Upload size={10} /> Nhập (Import)
                  <input type="file" accept=".tableplusconnection,.tableforgeconnection,.json" onChange={handleFileImportSelect} style={{ display: 'none' }} />
                </label>
              </div>

              <button 
                onClick={() => setShowImportUrlModal(true)} 
                style={{ 
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', padding: '5px', fontSize: '9px', 
                  border: '1px dashed var(--win-accent)', borderRadius: '4px', background: 'var(--win-bg-card)', 
                  cursor: 'pointer', color: 'var(--win-accent)', width: '100%', fontWeight: 600
                }} 
                title="Nhập cấu hình kết nối từ đường dẫn URL"
              >
                Nhập từ URL (Import URL)
              </button>
            </div>

            <button
              className={`connection-type-btn ${activeType === 'backup_restore' ? 'active' : ''}`}
              onClick={() => setActiveType('backup_restore' as any)}
              style={{ borderTop: '1px solid var(--win-border)', borderRadius: 0, padding: '12px' }}
            >
              <Database size={16} style={{ color: 'var(--win-accent)' }} />
              Backup & Restore
            </button>
          </div>

          <div className="connection-form-container">
            {errorMsg && (
              <div className="info-bar" style={{ background: 'rgba(239, 68, 68, 0.1)', borderLeftColor: '#ef4444', margin: '0 0 12px 0' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <AlertTriangle size={16} color="#ef4444" />
                  <span>{errorMsg}</span>
                </div>
              </div>
            )}
            
            {successMsg && (
              <div className="info-bar" style={{ background: 'rgba(16, 185, 129, 0.1)', borderLeftColor: '#10b981', margin: '0 0 12px 0' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <CheckCircle2 size={16} color="#10b981" />
                  <span>{successMsg}</span>
                </div>
              </div>
            )}

            {activeType !== 'backup_restore' && activeProfileId && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px', paddingBottom: '12px', borderBottom: '1px solid var(--win-border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <input
                    type="text"
                    className="form-input"
                    value={profileNameInput}
                    onChange={(e) => setProfileNameInput(e.target.value)}
                    placeholder="Tên cấu hình kết nối..."
                    style={{ flex: 1, height: '28px', fontSize: '11px' }}
                  />
                  <button
                    className="btn btn-secondary"
                    onClick={handleSaveProfile}
                    style={{ display: 'flex', alignItems: 'center', gap: '4px', height: '28px', padding: '0 10px', fontSize: '11px' }}
                  >
                    <Save size={12} />
                    Lưu
                  </button>
                </div>
                <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ fontSize: '10px', color: 'var(--win-text-secondary)' }}>Nhóm:</span>
                    <input
                      type="text"
                      className="form-input"
                      value={profileGroup}
                      onChange={(e) => setProfileGroup(e.target.value)}
                      placeholder="DEV, PROD..."
                      style={{ width: '100px', height: '22px', fontSize: '10px', padding: '0 4px' }}
                    />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ fontSize: '10px', color: 'var(--win-text-secondary)' }}>Màu:</span>
                    <div style={{ display: 'flex', gap: '4px' }}>
                      {[
                        { val: '', name: 'None', color: '#7f8c8d' },
                        { val: '#ff4d4d', name: 'Red', color: '#ff4d4d' },
                        { val: '#2ecc71', name: 'Green', color: '#2ecc71' },
                        { val: '#3498db', name: 'Blue', color: '#3498db' },
                        { val: '#f1c40f', name: 'Yellow', color: '#f1c40f' },
                        { val: '#9b59b6', name: 'Purple', color: '#9b59b6' }
                      ].map(c => (
                        <div
                          key={c.val}
                          onClick={() => setProfileColor(c.val)}
                          style={{
                            width: '14px',
                            height: '14px',
                            borderRadius: '50%',
                            background: c.color,
                            cursor: 'pointer',
                            border: profileColor === c.val ? '2px solid var(--win-text-primary)' : '1px solid rgba(0,0,0,0.15)',
                            boxSizing: 'border-box'
                          }}
                          title={c.name}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeType === 'sqlite' && (
              <div className="form-group">
                <label>Đường dẫn tệp SQLite (.db, .sqlite)</label>
                <input
                  type="text"
                  className="form-input"
                  value={sqlitePath}
                  onChange={(e) => setSqlitePath(e.target.value)}
                  placeholder="Nhập tên tệp (ví dụ: my_database.db)"
                />
                <span style={{ fontSize: '11px', color: 'var(--win-text-secondary)', marginTop: '4px' }}>
                  Nếu tệp chưa tồn tại, TableNova sẽ tự động khởi tạo tệp mới.
                </span>
              </div>
            )}

            {activeType === 'postgres' && (
              <>
                <div className="form-row">
                  <div className="form-group" style={{ flex: 3 }}>
                    <label>Địa chỉ máy chủ (Host)</label>
                    <input
                      type="text"
                      className="form-input"
                      value={pgHost}
                      onChange={(e) => setPgHost(e.target.value)}
                    />
                  </div>
                  <div className="form-group" style={{ flex: 1 }}>
                    <label>Cổng (Port)</label>
                    <input
                      type="number"
                      className="form-input"
                      value={pgPort}
                      onChange={(e) => setPgPort(parseInt(e.target.value) || 5432)}
                    />
                  </div>
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label>Tên đăng nhập (User)</label>
                    <input
                      type="text"
                      className="form-input"
                      value={pgUser}
                      onChange={(e) => setPgUser(e.target.value)}
                    />
                  </div>
                  <div className="form-group">
                    <label>Mật khẩu (Password)</label>
                    <input
                      type="password"
                      className="form-input"
                      value={pgPassword}
                      onChange={(e) => setPgPassword(e.target.value)}
                      placeholder="••••••••"
                    />
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px', background: 'rgba(0,0,0,0.1)', border: '1px solid var(--win-border)', borderRadius: '4px', marginTop: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontSize: '11px', color: 'var(--win-text-secondary)', fontWeight: 600 }}>SSL mode</span>
                      <select
                        className="form-input"
                        value={sslMode}
                        onChange={(e) => setSslMode(e.target.value)}
                        style={{ width: '130px', height: '24px', fontSize: '11px', padding: '0 4px' }}
                      >
                        <option value="DISABLED">DISABLED</option>
                        <option value="PREFERRED">PREFERRED</option>
                        <option value="REQUIRED">REQUIRED</option>
                        <option value="VERIFY_CA">VERIFY_CA</option>
                        <option value="VERIFY_IDENTITY">VERIFY_IDENTITY</option>
                      </select>
                    </div>
                    {sslMode !== 'DISABLED' && (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => {
                          setSslKeyPath('');
                          setSslCertPath('');
                          setSslCaPath('');
                        }}
                        style={{ height: '24px', fontSize: '10px', padding: '0 8px' }}
                      >
                        Clear keys
                      </button>
                    )}
                  </div>

                  {sslMode !== 'DISABLED' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
                      <span style={{ fontSize: '11px', color: 'var(--win-text-secondary)', minWidth: '55px' }}>SSL keys</span>
                      <div style={{ display: 'flex', gap: '4px', flex: 1 }}>
                        <div style={{ flex: 1 }}>
                          <input
                            type="file"
                            id="pg-ssl-key-picker"
                            style={{ display: 'none' }}
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) setSslKeyPath((file as any).path || file.name);
                            }}
                          />
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => document.getElementById('pg-ssl-key-picker')?.click()}
                            style={{ width: '100%', height: '24px', fontSize: '10px', padding: '0 4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                            title={sslKeyPath || 'Select Key file...'}
                          >
                            {sslKeyPath ? sslKeyPath.split(/[\\/]/).pop() : 'Key...'}
                          </button>
                        </div>

                        <div style={{ flex: 1 }}>
                          <input
                            type="file"
                            id="pg-ssl-cert-picker"
                            style={{ display: 'none' }}
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) setSslCertPath((file as any).path || file.name);
                            }}
                          />
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => document.getElementById('pg-ssl-cert-picker')?.click()}
                            style={{ width: '100%', height: '24px', fontSize: '10px', padding: '0 4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                            title={sslCertPath || 'Select Cert file...'}
                          >
                            {sslCertPath ? sslCertPath.split(/[\\/]/).pop() : 'Cert...'}
                          </button>
                        </div>

                        <div style={{ flex: 1 }}>
                          <input
                            type="file"
                            id="pg-ssl-ca-picker"
                            style={{ display: 'none' }}
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) setSslCaPath((file as any).path || file.name);
                            }}
                          />
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => document.getElementById('pg-ssl-ca-picker')?.click()}
                            style={{ width: '100%', height: '24px', fontSize: '10px', padding: '0 4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                            title={sslCaPath || 'Select CA Cert file...'}
                          >
                            {sslCaPath ? sslCaPath.split(/[\\/]/).pop() : 'CA Cert...'}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                <div className="form-group">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                    <label style={{ margin: 0 }}>Tên cơ sở dữ liệu (Database)</label>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => fetchDatabases('postgres')}
                      disabled={loadingDbs}
                      style={{ height: '18px', fontSize: '10px', padding: '0 6px', display: 'flex', alignItems: 'center', gap: '2px' }}
                    >
                      {loadingDbs ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                          <LoadingSpinner size={10} />
                          <span>Đang tải...</span>
                        </span>
                      ) : 'Tải danh sách'}
                    </button>
                  </div>
                  <input
                    type="text"
                    className="form-input"
                    list="pg-dbs"
                    value={pgDatabase}
                    onChange={(e) => setPgDatabase(e.target.value)}
                  />
                  <datalist id="pg-dbs">
                    {availableDatabases.map(db => (
                      <option key={db} value={db} />
                    ))}
                  </datalist>
                </div>
              </>
            )}

            {activeType === 'mysql' && (
              <>
                <div className="form-row">
                  <div className="form-group" style={{ flex: 3 }}>
                    <label>Địa chỉ máy chủ (Host)</label>
                    <input
                      type="text"
                      className="form-input"
                      value={myHost}
                      onChange={(e) => setMyHost(e.target.value)}
                    />
                  </div>
                  <div className="form-group" style={{ flex: 1 }}>
                    <label>Cổng (Port)</label>
                    <input
                      type="number"
                      className="form-input"
                      value={myPort}
                      onChange={(e) => setMyPort(parseInt(e.target.value) || 3306)}
                    />
                  </div>
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label>Tên đăng nhập (User)</label>
                    <input
                      type="text"
                      className="form-input"
                      value={myUser}
                      onChange={(e) => setMyUser(e.target.value)}
                    />
                  </div>
                  <div className="form-group">
                    <label>Mật khẩu (Password)</label>
                    <input
                      type="password"
                      className="form-input"
                      value={myPassword}
                      onChange={(e) => setMyPassword(e.target.value)}
                      placeholder="••••••••"
                    />
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px', background: 'rgba(0,0,0,0.1)', border: '1px solid var(--win-border)', borderRadius: '4px', marginTop: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontSize: '11px', color: 'var(--win-text-secondary)', fontWeight: 600 }}>SSL mode</span>
                      <select
                        className="form-input"
                        value={sslMode}
                        onChange={(e) => setSslMode(e.target.value)}
                        style={{ width: '130px', height: '24px', fontSize: '11px', padding: '0 4px' }}
                      >
                        <option value="DISABLED">DISABLED</option>
                        <option value="PREFERRED">PREFERRED</option>
                        <option value="REQUIRED">REQUIRED</option>
                        <option value="VERIFY_CA">VERIFY_CA</option>
                        <option value="VERIFY_IDENTITY">VERIFY_IDENTITY</option>
                      </select>
                    </div>
                    {sslMode !== 'DISABLED' && (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => {
                          setSslKeyPath('');
                          setSslCertPath('');
                          setSslCaPath('');
                        }}
                        style={{ height: '24px', fontSize: '10px', padding: '0 8px' }}
                      >
                        Clear keys
                      </button>
                    )}
                  </div>

                  {sslMode !== 'DISABLED' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
                      <span style={{ fontSize: '11px', color: 'var(--win-text-secondary)', minWidth: '55px' }}>SSL keys</span>
                      <div style={{ display: 'flex', gap: '4px', flex: 1 }}>
                        <div style={{ flex: 1 }}>
                          <input
                            type="file"
                            id="my-ssl-key-picker"
                            style={{ display: 'none' }}
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) setSslKeyPath((file as any).path || file.name);
                            }}
                          />
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => document.getElementById('my-ssl-key-picker')?.click()}
                            style={{ width: '100%', height: '24px', fontSize: '10px', padding: '0 4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                            title={sslKeyPath || 'Select Key file...'}
                          >
                            {sslKeyPath ? sslKeyPath.split(/[\\/]/).pop() : 'Key...'}
                          </button>
                        </div>

                        <div style={{ flex: 1 }}>
                          <input
                            type="file"
                            id="my-ssl-cert-picker"
                            style={{ display: 'none' }}
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) setSslCertPath((file as any).path || file.name);
                            }}
                          />
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => document.getElementById('my-ssl-cert-picker')?.click()}
                            style={{ width: '100%', height: '24px', fontSize: '10px', padding: '0 4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                            title={sslCertPath || 'Select Cert file...'}
                          >
                            {sslCertPath ? sslCertPath.split(/[\\/]/).pop() : 'Cert...'}
                          </button>
                        </div>

                        <div style={{ flex: 1 }}>
                          <input
                            type="file"
                            id="my-ssl-ca-picker"
                            style={{ display: 'none' }}
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) setSslCaPath((file as any).path || file.name);
                            }}
                          />
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => document.getElementById('my-ssl-ca-picker')?.click()}
                            style={{ width: '100%', height: '24px', fontSize: '10px', padding: '0 4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                            title={sslCaPath || 'Select CA Cert file...'}
                          >
                            {sslCaPath ? sslCaPath.split(/[\\/]/).pop() : 'CA Cert...'}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                <div className="form-group">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                    <label style={{ margin: 0 }}>Tên cơ sở dữ liệu (Database)</label>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => fetchDatabases('mysql')}
                      disabled={loadingDbs}
                      style={{ height: '18px', fontSize: '10px', padding: '0 6px', display: 'flex', alignItems: 'center', gap: '2px' }}
                    >
                      {loadingDbs ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                          <LoadingSpinner size={10} />
                          <span>Đang tải...</span>
                        </span>
                      ) : 'Tải danh sách'}
                    </button>
                  </div>
                  <input
                    type="text"
                    className="form-input"
                    list="my-dbs"
                    value={myDatabase}
                    onChange={(e) => setMyDatabase(e.target.value)}
                    placeholder="Không bắt buộc"
                  />
                  <datalist id="my-dbs">
                    {availableDatabases.map(db => (
                      <option key={db} value={db} />
                    ))}
                  </datalist>
                </div>
              </>
            )}

            {activeType !== 'sqlite' && (
              <div className="aws-iam-section" style={{ marginTop: '12px' }}>
                <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)' }}>Phương thức xác thực</label>
                <div style={{ display: 'flex', gap: '6px', margin: '6px 0 10px' }}>
                  {(['password', 'aws_iam'] as const).map(m => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setAuthMethod(m)}
                      style={{
                        padding: '6px 12px', fontSize: '11px', fontWeight: 600, borderRadius: '4px',
                        border: '1px solid var(--win-border)', cursor: 'pointer',
                        background: authMethod === m ? 'var(--win-accent)' : 'transparent',
                        color: authMethod === m ? '#fff' : 'var(--win-text-secondary)',
                      }}
                    >
                      {m === 'password' ? 'Mật khẩu' : 'AWS IAM (RDS/Aurora)'}
                    </button>
                  ))}
                </div>

                {authMethod === 'aws_iam' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px', background: 'rgba(0,0,0,0.12)', border: '1px solid var(--win-border)', borderRadius: '6px', marginBottom: '10px' }}>
                    <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)', lineHeight: 1.4 }}>
                      Token IAM 15 phút thay cho mật khẩu; SSL sẽ tự ép <b>Required</b>. Điền <b>DB user</b> ở ô User phía trên (user đã cấu hình IAM).
                    </div>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      {(['access_key', 'profile'] as const).map(t => (
                        <button
                          key={t}
                          type="button"
                          onClick={() => setAwsAuthType(t)}
                          style={{
                            flex: 1, padding: '5px', fontSize: '11px', borderRadius: '4px', cursor: 'pointer',
                            border: '1px solid var(--win-border)',
                            background: awsAuthType === t ? 'var(--win-accent)' : 'transparent',
                            color: awsAuthType === t ? '#fff' : 'var(--win-text-secondary)',
                          }}
                        >
                          {t === 'access_key' ? 'Access Key' : 'Profile (~/.aws)'}
                        </button>
                      ))}
                    </div>

                    {awsAuthType === 'access_key' ? (
                      <>
                        <div className="form-group">
                          <label>Access Key ID</label>
                          <input type="text" className="form-input" value={awsAccessKeyId} onChange={(e) => setAwsAccessKeyId(e.target.value)} placeholder="AKIA..." autoComplete="off" />
                        </div>
                        <div className="form-group">
                          <label>Secret Access Key</label>
                          <input type="password" className="form-input" value={awsSecretAccessKey} onChange={(e) => setAwsSecretAccessKey(e.target.value)} autoComplete="off" />
                        </div>
                        <div className="form-group">
                          <label>Session Token (không bắt buộc)</label>
                          <input type="password" className="form-input" value={awsSessionToken} onChange={(e) => setAwsSessionToken(e.target.value)} autoComplete="off" />
                        </div>
                      </>
                    ) : (
                      <div className="form-group">
                        <label>Tên profile</label>
                        <input type="text" className="form-input" value={awsProfile} onChange={(e) => setAwsProfile(e.target.value)} placeholder="default" autoComplete="off" />
                      </div>
                    )}

                    <div className="form-group">
                      <label>AWS Region (để trống = tự dò từ host RDS)</label>
                      <input type="text" className="form-input" value={awsRegion} onChange={(e) => setAwsRegion(e.target.value)} placeholder="vd: ap-southeast-1" autoComplete="off" />
                    </div>
                  </div>
                )}
              </div>
            )}

            {activeType !== 'sqlite' && (
              <div className="ssh-tunnel-section" style={{ marginTop: '12px' }}>
                <button
                  type="button"
                  onClick={() => setSshEnabled(!sshEnabled)}
                  style={{
                    padding: '6px 12px',
                    fontSize: '11px',
                    fontWeight: 600,
                    borderRadius: '4px',
                    border: '1px solid var(--win-border)',
                    background: sshEnabled ? 'var(--win-accent-alpha, rgba(46, 204, 113, 0.2))' : 'transparent',
                    color: sshEnabled ? '#2ecc71' : 'var(--win-text-secondary)',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    marginBottom: '10px'
                  }}
                >
                  <Server size={12} />
                  {sshEnabled ? 'Over SSH: Bật' : 'Over SSH'}
                </button>

                {sshEnabled && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '16px' }}>
                    <div className="form-row">
                      <div className="form-group" style={{ flex: 3 }}>
                        <label>SSH Host</label>
                        <input
                          type="text"
                          className="form-input"
                          value={sshHost}
                          onChange={(e) => setSshHost(e.target.value)}
                          placeholder="ví dụ: ssh.server.com"
                        />
                      </div>
                      <div className="form-group" style={{ flex: 1 }}>
                        <label>SSH Port</label>
                        <input
                          type="number"
                          className="form-input"
                          value={sshPort}
                          onChange={(e) => setSshPort(parseInt(e.target.value) || 22)}
                        />
                      </div>
                    </div>

                    <div className="form-row">
                      <div className="form-group">
                        <label>SSH Username</label>
                        <input
                          type="text"
                          className="form-input"
                          value={sshUser}
                          onChange={(e) => setSshUser(e.target.value)}
                          placeholder="root"
                        />
                      </div>
                      <div className="form-group">
                        <label>Phương thức xác thực SSH</label>
                        <select
                          className="form-input"
                          value={sshAuthType}
                          onChange={(e: any) => setSshAuthType(e.target.value)}
                        >
                          <option value="password">Mật khẩu (Password)</option>
                          <option value="key">Khóa riêng tư (Private Key)</option>
                        </select>
                      </div>
                    </div>

                    {sshAuthType === 'password' ? (
                      <div className="form-group">
                        <label>SSH Mật khẩu</label>
                        <input
                          type="password"
                          className="form-input"
                          value={sshPassword}
                          onChange={(e) => setSshPassword(e.target.value)}
                          placeholder="••••••••"
                        />
                      </div>
                    ) : (
                      <>
                        <div className="form-group">
                          <label>Đường dẫn file Private Key (hoặc nhập trực tiếp bên dưới)</label>
                          <div style={{ display: 'flex', gap: '8px' }}>
                            <input
                              type="text"
                              className="form-input"
                              value={sshKeyPath}
                              onChange={(e) => setSshKeyPath(e.target.value)}
                              placeholder="C:\Users\username\.ssh\id_rsa"
                              style={{ flex: 1 }}
                            />
                            <input
                              type="file"
                              id="ssh-key-file-picker"
                              style={{ display: 'none' }}
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) {
                                  const absolutePath = (file as any).path || file.name;
                                  setSshKeyPath(absolutePath);
                                }
                              }}
                            />
                            <button
                              type="button"
                              className="btn btn-secondary"
                              onClick={() => document.getElementById('ssh-key-file-picker')?.click()}
                              style={{ height: '30px', fontSize: '11px', padding: '0 10px', whiteSpace: 'nowrap' }}
                            >
                              Chọn tệp...
                            </button>
                          </div>
                        </div>
                        <div className="form-group">
                          <label>Nội dung Private Key</label>
                          <textarea
                            className="form-input"
                            style={{ minHeight: '80px', fontFamily: 'monospace', fontSize: '11px', resize: 'vertical' }}
                            value={sshKeyContent}
                            onChange={(e) => setSshKeyContent(e.target.value)}
                            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;..."
                          />
                        </div>
                        <div className="form-group">
                          <label>Mật khẩu giải mã Khóa (Passphrase) - nếu có</label>
                          <input
                            type="password"
                            className="form-input"
                            value={sshPassphrase}
                            onChange={(e) => setSshPassphrase(e.target.value)}
                            placeholder="••••••••"
                          />
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {(activeType as any) === 'backup_restore' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <div style={{ display: 'flex', gap: '8px', borderBottom: '1px solid var(--win-border)', paddingBottom: '8px', marginBottom: '8px' }}>
                  <button
                    onClick={() => setBrAction('backup')}
                    style={{
                      padding: '6px 12px', fontSize: '11px', fontWeight: 600, border: 'none', borderRadius: '4px',
                      background: brAction === 'backup' ? 'var(--win-accent)' : 'transparent',
                      color: brAction === 'backup' ? '#fff' : 'var(--win-text-secondary)', cursor: 'pointer'
                    }}
                  >
                    Sao lưu (Backup)
                  </button>
                  <button
                    onClick={() => setBrAction('restore')}
                    style={{
                      padding: '6px 12px', fontSize: '11px', fontWeight: 600, border: 'none', borderRadius: '4px',
                      background: brAction === 'restore' ? 'var(--win-accent)' : 'transparent',
                      color: brAction === 'restore' ? '#fff' : 'var(--win-text-secondary)', cursor: 'pointer'
                    }}
                  >
                    Khôi phục (Restore)
                  </button>
                </div>

                <div className="form-group">
                  <label>Chọn Kết nối đã lưu (Saved Connection)</label>
                  <select
                    className="form-input"
                    value={selectedBrProfileId || ''}
                    onChange={(e) => {
                      const profId = e.target.value;
                      setSelectedBrProfileId(profId);
                      const selectedProf = profiles.find(p => p.id === profId);
                      if (selectedProf) {
                        setBrType(selectedProf.type);
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
                    style={{ height: '32px', fontSize: '11px' }}
                  >
                    <option value="">-- Chọn kết nối cấu hình sẵn --</option>
                    {profiles.map(p => (
                      <option key={p.id} value={p.id}>{p.name} ({p.type.toUpperCase()})</option>
                    ))}
                  </select>
                </div>

                <div className="form-group">
                  <label>Loại Cơ sở dữ liệu</label>
                  <select
                    className="form-input"
                    value={brType}
                    onChange={(e) => setBrType(e.target.value as any)}
                    style={{ height: '32px', fontSize: '11px' }}
                  >
                    <option value="sqlite">SQLite</option>
                    <option value="postgres">PostgreSQL</option>
                    <option value="mysql">MySQL</option>
                  </select>
                </div>

                {brType === 'sqlite' ? (
                  <div className="form-group">
                    <label>Đường dẫn tệp SQLite (.db, .sqlite)</label>
                    <input
                      type="text"
                      className="form-input"
                      value={brSqlitePath}
                      onChange={(e) => setBrSqlitePath(e.target.value)}
                    />
                  </div>
                ) : (
                  <>
                    <div className="form-row">
                      <div className="form-group" style={{ flex: 3 }}>
                        <label>Địa chỉ máy chủ (Host)</label>
                        <input
                          type="text"
                          className="form-input"
                          value={brType === 'postgres' ? brPgHost : brMyHost}
                          onChange={(e) => brType === 'postgres' ? setBrPgHost(e.target.value) : setBrMyHost(e.target.value)}
                        />
                      </div>
                      <div className="form-group" style={{ flex: 1 }}>
                        <label>Cổng (Port)</label>
                        <input
                          type="number"
                          className="form-input"
                          value={brType === 'postgres' ? brPgPort : brMyPort}
                          onChange={(e) => brType === 'postgres' ? setBrPgPort(parseInt(e.target.value) || 5432) : setBrMyPort(parseInt(e.target.value) || 3306)}
                        />
                      </div>
                    </div>
                    <div className="form-row">
                      <div className="form-group">
                        <label>Tên đăng nhập (User)</label>
                        <input
                          type="text"
                          className="form-input"
                          value={brType === 'postgres' ? brPgUser : brMyUser}
                          onChange={(e) => brType === 'postgres' ? setBrPgUser(e.target.value) : setBrMyUser(e.target.value)}
                        />
                      </div>
                      <div className="form-group">
                        <label>Mật khẩu (Password)</label>
                        <input
                          type="password"
                          className="form-input"
                          value={brType === 'postgres' ? brPgPassword : brMyPassword}
                          onChange={(e) => brType === 'postgres' ? setBrPgPassword(e.target.value) : setBrMyPassword(e.target.value)}
                        />
                      </div>
                    </div>
                    <div className="form-group">
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                        <label style={{ margin: 0 }}>Tên cơ sở dữ liệu (Database)</label>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => fetchDatabases(brType === 'postgres' ? 'br_postgres' : 'br_mysql')}
                          disabled={loadingDbs}
                          style={{ height: '18px', fontSize: '10px', padding: '0 6px', display: 'flex', alignItems: 'center', gap: '2px' }}
                        >
                          {loadingDbs ? 'Đang tải...' : 'Tải danh sách'}
                        </button>
                      </div>
                      <input
                        type="text"
                        className="form-input"
                        list="br-dbs"
                        value={brType === 'postgres' ? brPgDatabase : brMyDatabase}
                        onChange={(e) => brType === 'postgres' ? setBrPgDatabase(e.target.value) : setBrMyDatabase(e.target.value)}
                      />
                      <datalist id="br-dbs">
                        {availableDatabases.map(db => (
                          <option key={db} value={db} />
                        ))}
                      </datalist>
                    </div>
                  </>
                )}

                <div style={{ borderTop: '1px solid var(--win-border)', paddingTop: '10px', marginTop: '6px' }} />

                {brAction === 'backup' ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    <div className="form-group">
                      <label>Tên tệp sao lưu (Backup Name)</label>
                      <input
                        type="text"
                        className="form-input"
                        value={brFilename}
                        onChange={(e) => setBrFilename(e.target.value)}
                      />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--win-text-primary)' }}>
                        <input type="checkbox" checked={brDropTable} onChange={(e) => setBrDropTable(e.target.checked)} />
                        <span>Drop table if exists</span>
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--win-text-primary)' }}>
                        <input type="checkbox" checked={brIncludeStructure} onChange={(e) => setBrIncludeStructure(e.target.checked)} />
                        <span>Include table structure</span>
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--win-text-primary)' }}>
                        <input type="checkbox" checked={brIncludeContent} onChange={(e) => setBrIncludeContent(e.target.checked)} />
                        <span>Include table content</span>
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--win-text-primary)' }}>
                        <input type="checkbox" checked={brCompressGzip} onChange={(e) => setBrCompressGzip(e.target.checked)} />
                        <span>Compress file using Gzip (.sql.gz)</span>
                      </label>
                    </div>
                    <button
                      className="btn btn-primary"
                      onClick={handleBrSubmit}
                      disabled={brLoading}
                      style={{ height: '32px', fontSize: '11px', background: 'var(--win-accent)', color: '#fff', border: 'none', fontWeight: 600, borderRadius: '4px', marginTop: '6px' }}
                    >
                      {brLoading ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                          <LoadingSpinner size={12} />
                          <span>Đang thực hiện sao lưu...</span>
                        </span>
                      ) : 'Bắt đầu Sao lưu (Backup)'}
                    </button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    <div className="form-group">
                      <label>Chọn tệp sao lưu (.sql hoặc .sql.gz)</label>
                      <input
                        type="file"
                        accept=".sql,.dump,.gz"
                        onChange={(e) => setBrFile(e.target.files?.[0] || null)}
                        style={{ fontSize: '11px' }}
                      />
                    </div>

                    {brParsing && (
                      <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)', marginTop: '4px' }}>
                        Đang đọc danh sách bảng từ file...
                      </div>
                    )}

                    {brParsedTables.length > 0 && (
                      <div style={{ marginTop: '8px', border: '1px solid var(--win-border)', borderRadius: '4px', padding: '10px', background: 'rgba(0,0,0,0.1)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', borderBottom: '1px solid var(--win-border)', paddingBottom: '4px' }}>
                          <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--win-text-primary)' }}>Chọn bảng muốn import ({brSelectedTables.length}/{brParsedTables.length})</span>
                          <button
                            type="button"
                            onClick={() => {
                              if (brSelectedTables.length === brParsedTables.length) {
                                setBrSelectedTables([]);
                              } else {
                                setBrSelectedTables([...brParsedTables]);
                              }
                            }}
                            style={{ padding: '2px 6px', fontSize: '9px', cursor: 'pointer', background: 'var(--win-bg-card)', border: '1px solid var(--win-border)', borderRadius: '3px', color: 'var(--win-text-primary)' }}
                          >
                            {brSelectedTables.length === brParsedTables.length ? 'Bỏ chọn tất cả' : 'Chọn tất cả'}
                          </button>
                        </div>
                        <div style={{ maxHeight: '120px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                          {brParsedTables.map(t => {
                            const isChecked = brSelectedTables.includes(t);
                            return (
                              <label key={t} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={() => {
                                    if (isChecked) {
                                      setBrSelectedTables(brSelectedTables.filter(x => x !== t));
                                    } else {
                                      setBrSelectedTables([...brSelectedTables, t]);
                                    }
                                  }}
                                />
                                <span>{t}</span>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    <button
                      className="btn btn-primary"
                      onClick={handleBrSubmit}
                      disabled={brLoading || !brFile || (brParsedTables.length > 0 && brSelectedTables.length === 0)}
                      style={{ height: '32px', fontSize: '11px', background: 'var(--win-accent)', color: '#fff', border: 'none', fontWeight: 600, borderRadius: '4px', marginTop: '6px' }}
                    >
                      {brLoading ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                          <LoadingSpinner size={12} />
                          <span>Đang khôi phục dữ liệu...</span>
                        </span>
                      ) : 'Bắt đầu Khôi phục (Restore)'}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="connection-footer">
          {activeType !== 'backup_restore' && (
            <div style={{ display: 'flex', gap: '8px', width: '100%', justifyContent: 'flex-end' }}>
              {activeProfileId && (
                <button
                  className="btn btn-secondary"
                  onClick={handleSaveProfile}
                  style={{ marginRight: 'auto' }}
                >
                  Save
                </button>
              )}
              <button
                className="btn btn-secondary"
                onClick={handleTestConnection}
                disabled={loading}
              >
                Test
              </button>
              <button
                className="btn btn-primary"
                onClick={() => handleConnect(false)}
                disabled={loading}
                style={{ background: 'var(--win-accent)', color: '#fff', border: 'none', fontWeight: 600 }}
              >
                {loading ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                    <LoadingSpinner size={12} />
                    <span>Connecting...</span>
                  </span>
                ) : 'Connect'}
              </button>
            </div>
          )}
        </div>
      </div>

      {showImportUrlModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.65)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 10000,
          backdropFilter: 'blur(2px)'
        }}>
          <div style={{
            background: 'var(--win-bg-card)',
            border: '1px solid var(--win-border-strong, var(--win-border))',
            borderRadius: '8px',
            width: '420px',
            boxShadow: '0 20px 40px rgba(0,0,0,0.5)',
            padding: '20px',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px'
          }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: 0, fontSize: '15px', color: 'var(--win-text-primary)' }}>Import Connection URL</h3>
            <p style={{ margin: 0, fontSize: '11.5px', color: 'var(--win-text-secondary)', lineHeight: '1.4' }}>
              Dán đường dẫn kết nối URL của bạn vào ô dưới đây để tự động nhập cấu hình.
            </p>
            <div className="form-group" style={{ margin: 0 }}>
              <label>Connection URL</label>
              <input
                type="text"
                className="form-input"
                value={importUrlInput}
                onChange={(e) => setImportUrlInput(e.target.value)}
                placeholder="postgresql://user:password@host:port/database"
                style={{ width: '100%', boxSizing: 'border-box' }}
                autoFocus
              />
            </div>
            <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)' }}>
              Ví dụ: <code style={{ background: 'rgba(255,255,255,0.05)', padding: '2px 4px', borderRadius: '3px' }}>postgres://user:password@host:5432/database</code>
            </div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '4px' }}>
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setShowImportUrlModal(false);
                  setImportUrlInput('');
                }}
              >
                Hủy (Cancel)
              </button>
              <button
                className="btn btn-primary"
                onClick={handleImportUrlSubmit}
                disabled={!importUrlInput.trim()}
                style={{ background: '#2ecc71', color: '#fff', border: 'none', fontWeight: 600 }}
              >
                Nhập (Import)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Context Menu for Connections & Groups */}
      {contextMenu && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onClick={() => setContextMenu(null)} />
          <div style={{
            position: 'fixed',
            top: contextMenu.y,
            left: contextMenu.x,
            width: 'max-content',
            minWidth: '220px',
            background: 'var(--win-bg-card, #2d3139)',
            border: '1px solid var(--win-border-strong, #383b44)',
            borderRadius: '6px',
            boxShadow: '0 12px 36px rgba(0,0,0,0.45)',
            zIndex: 9999,
            padding: '4px 0',
            boxSizing: 'border-box'
          }}>
            {contextMenu.scope === 'single' && contextMenu.profile && (
              <button
                className="context-menu-item"
                onClick={() => { setTerminalProfile(contextMenu.profile!); setContextMenu(null); }}
              >
                <TerminalSquare size={13} style={{ flexShrink: 0 }} />
                <span>
                  {contextMenu.profile.config?.sshEnabled && contextMenu.profile.config?.sshHost
                    ? 'Mở SSH Terminal'
                    : 'Mở Terminal (local)'}
                </span>
              </button>
            )}
            {contextMenu.scope === 'single' && contextMenu.profile && (
              <button
                className="context-menu-item"
                onClick={() => openExportModal('single', undefined, contextMenu.profile)}
              >
                <Download size={13} style={{ flexShrink: 0 }} />
                <span>Xuất kết nối này</span>
              </button>
            )}
            {(contextMenu.scope === 'group' || contextMenu.scope === 'single') && contextMenu.groupName && (
              <button 
                className="context-menu-item" 
                onClick={() => openExportModal('group', contextMenu.groupName)}
              >
                <Download size={13} style={{ flexShrink: 0 }} />
                <span>Xuất nhóm "{contextMenu.groupName}"</span>
              </button>
            )}
            <button 
              className="context-menu-item" 
              onClick={() => openExportModal('all')}
            >
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

      {/* Export Connections Options Modal */}
      {showExportModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.65)',
          display: 'flex', justifyContent: 'center', alignItems: 'center',
          zIndex: 10000, backdropFilter: 'blur(2px)'
        }}>
          <div style={{
            background: 'var(--win-bg-card)', border: '1px solid var(--win-border-strong, var(--win-border))',
            borderRadius: '8px', width: '420px', boxShadow: '0 20px 40px rgba(0,0,0,0.5)',
            padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px'
          }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Download size={18} style={{ color: 'var(--win-accent)' }} />
              <h3 style={{ margin: 0, fontSize: '15px', color: 'var(--win-text-primary)' }}>
                {exportScope === 'group' ? `Xuất nhóm kết nối: "${exportGroupTarget}"` :
                 exportScope === 'single' ? `Xuất kết nối: "${exportSingleProfile?.name}"` :
                 'Xuất tất cả kết nối (Export All)'}
              </h3>
            </div>
            


            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', background: 'rgba(0,0,0,0.1)', padding: '12px', borderRadius: '6px', border: '1px solid var(--win-border)' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11.5px', color: 'var(--win-text-primary)', cursor: 'pointer' }}>
                <input 
                  type="checkbox" 
                  checked={exportIncludePasswords} 
                  onChange={(e) => setExportIncludePasswords(e.target.checked)} 
                />
                <span style={{ fontWeight: 600 }}>Kèm theo Mật khẩu Database / Server (Include Passwords)</span>
              </label>
              <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)', marginLeft: '24px' }}>
                {exportIncludePasswords ? '⚠ Cảnh báo: Mật khẩu kết nối sẽ được lưu trong tệp xuất.' : '✓ An toàn: Mật khẩu kết nối sẽ bị xóa khỏi tệp xuất.'}
              </div>

              <div className="form-group" style={{ margin: 0, marginTop: '4px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px' }}>
                  <Lock size={12} />
                  <span>Mật khẩu bảo vệ tệp (Set File Password - Tùy chọn)</span>
                </label>
                <input
                  type="password"
                  className="form-input"
                  value={exportFilePassword}
                  onChange={(e) => setExportFilePassword(e.target.value)}
                  placeholder="Để trống nếu không muốn đặt mật khẩu"
                  style={{ width: '100%', boxSizing: 'border-box', height: '28px', fontSize: '11px' }}
                />
              </div>
            </div>

            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button
                className="btn btn-secondary"
                onClick={() => setShowExportModal(false)}
                disabled={exporting}
              >
                Hủy (Cancel)
              </button>
              <button
                className="btn btn-primary"
                onClick={handlePerformExport}
                disabled={exporting}
                style={{ background: 'var(--win-accent)', color: '#fff', border: 'none', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}
              >
                {exporting ? <LoadingSpinner size={12} /> : <Download size={12} />}
                <span>Xuất (Export)</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import Password Prompt Modal */}
      {showImportPasswordModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.65)',
          display: 'flex', justifyContent: 'center', alignItems: 'center',
          zIndex: 10000, backdropFilter: 'blur(2px)'
        }}>
          <div style={{
            background: 'var(--win-bg-card)', border: '1px solid var(--win-border-strong, var(--win-border))',
            borderRadius: '8px', width: '380px', boxShadow: '0 20px 40px rgba(0,0,0,0.5)',
            padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px'
          }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Lock size={18} style={{ color: '#f59e0b' }} />
              <h3 style={{ margin: 0, fontSize: '15px', color: 'var(--win-text-primary)' }}>Tệp kết nối bị khóa</h3>
            </div>
            
            <p style={{ margin: 0, fontSize: '11.5px', color: 'var(--win-text-secondary)', lineHeight: '1.4' }}>
              Tệp kết nối này được mã hóa bằng mật khẩu. Vui lòng nhập mật khẩu giải mã để tiếp tục nhập kết nối.
            </p>

            <div className="form-group" style={{ margin: 0 }}>
              <label>Mật khẩu tệp (File Password)</label>
              <input
                type="password"
                className="form-input"
                value={importPasswordInput}
                onChange={(e) => setImportPasswordInput(e.target.value)}
                placeholder="Nhập mật khẩu..."
                onKeyDown={(e) => { if (e.key === 'Enter') handlePasswordDecryptSubmit(); }}
                style={{ width: '100%', boxSizing: 'border-box' }}
                autoFocus
              />
            </div>

            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '4px' }}>
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setShowImportPasswordModal(false);
                  setPendingImportContent(null);
                }}
                disabled={importing}
              >
                Hủy (Cancel)
              </button>
              <button
                className="btn btn-primary"
                onClick={handlePasswordDecryptSubmit}
                disabled={importing || !importPasswordInput.trim()}
                style={{ background: 'var(--win-accent)', color: '#fff', border: 'none', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}
              >
                {importing ? <LoadingSpinner size={12} /> : <Key size={12} />}
                <span>Giải mã & Nhập</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
