import { describe, expect, it } from 'vitest';
import {
  SECRET_FIELDS,
  hasInlineSecrets,
  mergeSecrets,
  newProfileId,
  splitSecrets,
  stripSecrets,
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

describe('splitSecrets', () => {
  it('tách hết field bí mật ra khỏi phần lưu được', () => {
    const { safe, secrets } = splitSecrets(fullConfig);
    for (const f of SECRET_FIELDS) {
      expect(safe).not.toHaveProperty(f);
      expect(secrets[f]).toBe((fullConfig as any)[f]);
    }
  });

  it('giữ nguyên field không nhạy cảm, kể cả sshKeyPath và awsAccessKeyId', () => {
    const { safe } = splitSecrets(fullConfig);
    expect(safe.host).toBe('db.example.com');
    expect(safe.port).toBe(5432);
    expect(safe.sshKeyPath).toBe('/home/ops/.ssh/id_ed25519');
    expect(safe.awsAccessKeyId).toBe('AKIA...');
  });

  it('bỏ qua bí mật rỗng để không tạo mục thừa trong kho HĐH', () => {
    const { secrets } = splitSecrets({ host: 'h', password: '', sshPassphrase: 'x' });
    expect(secrets).toEqual({ sshPassphrase: 'x' });
  });

  it('chịu được config null/undefined', () => {
    expect(splitSecrets(null)).toEqual({ safe: null, secrets: {} });
    expect(splitSecrets(undefined)).toEqual({ safe: undefined, secrets: {} });
  });

  it('không có bí mật nào lọt vào chuỗi JSON đem lưu', () => {
    const json = JSON.stringify(splitSecrets(fullConfig).safe);
    expect(json).not.toContain('p@ss');
    expect(json).not.toContain('BEGIN OPENSSH PRIVATE KEY');
    expect(json).not.toContain('aws-secret');
    expect(json).not.toContain('phrase');
  });
});

describe('mergeSecrets', () => {
  it('ghép bí mật trở lại config đã bóc', () => {
    const { safe, secrets } = splitSecrets(fullConfig);
    expect(mergeSecrets(safe, secrets)).toEqual(fullConfig);
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
    expect(hasInlineSecrets(splitSecrets(fullConfig).safe)).toBe(false);
    expect(hasInlineSecrets({ host: 'h', password: '' })).toBe(false);
    expect(hasInlineSecrets(null)).toBe(false);
  });
});

describe('stripSecrets', () => {
  it('bỏ khoá bí mật kể cả khi giá trị rỗng', () => {
    expect(stripSecrets({ host: 'h', password: '', sshPassword: 'x' })).toEqual({ host: 'h' });
  });
});

describe('newProfileId', () => {
  it('giữ tiền tố profile_ và không trùng nhau', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newProfileId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id.startsWith('profile_')).toBe(true);
  });
});
