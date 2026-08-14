import { describe, it, expect } from 'vitest';
import { getDialectName, buildSystemPrompt, extractSqlFromText } from '../aiContextBuilder';
import { DEFAULT_AI_PROFILES, DEFAULT_AI_SETTINGS } from '../aiConfig';

describe('aiContextBuilder', () => {
  it('detects correct SQL dialect name from dbType', () => {
    expect(getDialectName('postgres')).toBe('PostgreSQL');
    expect(getDialectName('postgresql')).toBe('PostgreSQL');
    expect(getDialectName('mysql')).toBe('MySQL');
    expect(getDialectName('sqlite')).toBe('SQLite');
    expect(getDialectName('mssql')).toBe('Microsoft SQL Server');
    expect(getDialectName('redis')).toBe('Redis');
    expect(getDialectName(undefined)).toBe('SQL Standard');
  });

  it('builds system prompt with schema context and guidelines', () => {
    const schema = 'Target SQL Dialect: PostgreSQL\n\nDatabase Schema:\nTable: users\nColumns: id (INT, PK), email (VARCHAR)';
    const prompt = buildSystemPrompt(schema, 'Always use UPPERCASE SQL keywords.');

    expect(prompt).toContain('TableNova AI Copilot');
    expect(prompt).toContain('PostgreSQL');
    expect(prompt).toContain('Table: users');
    expect(prompt).toContain('Always use UPPERCASE SQL keywords.');
  });

  it('extracts SQL queries from markdown code blocks', () => {
    const markdown = 'Here is your query:\n```sql\nSELECT * FROM users WHERE active = true;\n```\nHope that helps!';
    const extracted = extractSqlFromText(markdown);
    expect(extracted).toBe('SELECT * FROM users WHERE active = true;');

    const markdownNoTag = '```\nSELECT count(*) FROM orders;\n```';
    expect(extractSqlFromText(markdownNoTag)).toBe('SELECT count(*) FROM orders;');

    const noSql = 'There is no SQL block in this text.';
    expect(extractSqlFromText(noSql)).toBeUndefined();
  });
});

describe('aiConfig', () => {
  it('contains default profiles for OpenAI, DeepSeek, Gemini, and Ollama', () => {
    expect(DEFAULT_AI_PROFILES.length).toBeGreaterThanOrEqual(4);
    const providers = DEFAULT_AI_PROFILES.map((p) => p.provider);
    expect(providers).toContain('openai');
    expect(providers).toContain('deepseek');
    expect(providers).toContain('gemini');
    expect(providers).toContain('ollama');
  });

  it('has default active profile set', () => {
    expect(DEFAULT_AI_SETTINGS.activeProfileId).toBe('assistant-1');
  });
});
