import { describe, expect, it } from 'vitest';
import {
  SECRET_FIELDS,
  hasInlineSecrets,
  mergeSecrets,
  newProfileId,
  pickSecrets,
  publicConfig,
} from '../secretFields';

const fullConfig = {
  type: 'postgres',
  host: 'db.example.com',
  port: 5432,
  user: 'postgres',
  database: 'app',
  password: 'p@ss',
  sshEnabled: true,
  sshHost: 'bastion',
  sshUser: 'ops',
  sshKeyPath: '/home/ops/.ssh/id_ed25519',
  sshPassword: 'ssh-pw',
  sshPassphrase: 'phrase',
  sshKeyContent: '-----BEGIN OPENSSH PRIVATE KEY-----',
  awsSecretAccessKey: 'aws-secret',
  awsSessionToken: 'aws-token',
  awsAccessKeyId: 'AKIA...',
};

describe('publicConfig', () => {
  it('bỏ hết field bí mật', () => {
    const safe = publicConfig(fullConfig);
    for (const f of SECRET_FIELDS) expect(safe).not.toHaveProperty(f);
  });

  it('bỏ khoá bí mật kể cả khi giá trị rỗng', () => {
    expect(publicConfig({ host: 'h', password: '', sshPassword: 'x' })).toEqual({ host: 'h' });
  });

  it('giữ nguyên field không nhạy cảm, kể cả sshKeyPath và awsAccessKeyId', () => {
    const safe = publicConfig(fullConfig);
    expect(safe.host).toBe('db.example.com');
    expect(safe.port).toBe(5432);
    expect(safe.sshKeyPath).toBe('/home/ops/.ssh/id_ed25519');
    expect(safe.awsAccessKeyId).toBe('AKIA...');
  });

  it('chịu được config null/undefined', () => {
    expect(publicConfig(null)).toBeNull();
    expect(publicConfig(undefined)).toBeUndefined();
  });

  it('không có bí mật nào lọt vào chuỗi JSON đem lưu', () => {
    const json = JSON.stringify(publicConfig(fullConfig));
    expect(json).not.toContain('p@ss');
    expect(json).not.toContain('BEGIN OPENSSH PRIVATE KEY');
    expect(json).not.toContain('aws-secret');
    expect(json).not.toContain('phrase');
  });
});

describe('pickSecrets', () => {
  it('lấy đủ mọi field bí mật', () => {
    const values = pickSecrets(fullConfig);
    for (const f of SECRET_FIELDS) expect(values[f]).toBe((fullConfig as any)[f]);
  });

  it('không lấy field không nhạy cảm', () => {
    expect(pickSecrets(fullConfig)).not.toHaveProperty('host');
    expect(pickSecrets(fullConfig)).not.toHaveProperty('awsAccessKeyId');
  });

  it('bỏ qua bí mật rỗng để không tạo mục thừa trong kho HĐH', () => {
    expect(pickSecrets({ host: 'h', password: '', sshPassphrase: 'x' })).toEqual({ sshPassphrase: 'x' });
  });

  it('chịu được config null/undefined', () => {
    expect(pickSecrets(null)).toEqual({});
    expect(pickSecrets(undefined)).toEqual({});
  });
});

describe('publicConfig + pickSecrets', () => {
  it('hai nửa cộng lại đúng bằng config ban đầu', () => {
    expect({ ...publicConfig(fullConfig), ...pickSecrets(fullConfig) }).toEqual(fullConfig);
  });
});

describe('mergeSecrets', () => {
  it('ghép bí mật trở lại config đã bóc', () => {
    expect(mergeSecrets(publicConfig(fullConfig), pickSecrets(fullConfig))).toEqual(fullConfig);
  });

  it('bí mật từ kho HĐH đè lên giá trị cũ còn sót trong config', () => {
    const merged = mergeSecrets({ host: 'h', password: 'cũ' }, { password: 'mới' });
    expect(merged.password).toBe('mới');
  });

  it('chịu được safe null', () => {
    expect(mergeSecrets(null, { password: 'x' })).toEqual({ password: 'x' });
  });
});

describe('hasInlineSecrets', () => {
  it('nhận ra profile cũ còn mật khẩu nằm thẳng trong config', () => {
    expect(hasInlineSecrets(fullConfig)).toBe(true);
    expect(hasInlineSecrets({ host: 'h', sshKeyContent: '-----BEGIN' })).toBe(true);
  });

  it('trả về false khi đã bóc sạch hoặc chỉ còn chuỗi rỗng', () => {
    expect(hasInlineSecrets(publicConfig(fullConfig))).toBe(false);
    expect(hasInlineSecrets({ host: 'h', password: '' })).toBe(false);
    expect(hasInlineSecrets(null)).toBe(false);
  });
});

describe('newProfileId', () => {
  it('giữ tiền tố profile_ và không trùng nhau', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newProfileId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id.startsWith('profile_')).toBe(true);
  });
});
