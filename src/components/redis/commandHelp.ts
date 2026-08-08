// Command reference behind the CLI console's auto-complete and inline hint.
//
// Only the *syntax* is listed, never a prose description. Command signatures are protocol
// text (they read the same in every language), so nothing here needs an i18n key — which is
// also why this table can stay this large without tripling the locale files.
//
// Not exhaustive by design: it covers what a data-browsing session actually types. An unknown
// command still runs — the hint simply stays empty.

export interface CommandEntry {
  name: string;
  args: string;
}

export const COMMANDS: CommandEntry[] = [
  // connection / server
  { name: 'PING', args: '[message]' },
  { name: 'ECHO', args: 'message' },
  { name: 'SELECT', args: 'index' },
  { name: 'INFO', args: '[section]' },
  { name: 'DBSIZE', args: '' },
  { name: 'TIME', args: '' },
  { name: 'LASTSAVE', args: '' },
  { name: 'CONFIG GET', args: 'parameter [parameter ...]' },
  { name: 'CONFIG SET', args: 'parameter value [parameter value ...]' },
  { name: 'CLIENT LIST', args: '[TYPE normal|master|replica|pubsub]' },
  { name: 'CLIENT INFO', args: '' },
  { name: 'CLIENT KILL', args: 'ID client-id | ADDR addr' },
  { name: 'COMMAND DOCS', args: '[command-name ...]' },
  { name: 'SLOWLOG GET', args: '[count]' },
  { name: 'SLOWLOG LEN', args: '' },
  { name: 'SLOWLOG RESET', args: '' },
  { name: 'MEMORY USAGE', args: 'key [SAMPLES count]' },
  { name: 'MEMORY STATS', args: '' },
  { name: 'MEMORY DOCTOR', args: '' },
  { name: 'OBJECT ENCODING', args: 'key' },
  { name: 'OBJECT FREQ', args: 'key' },
  { name: 'OBJECT IDLETIME', args: 'key' },
  { name: 'ACL WHOAMI', args: '' },
  { name: 'ACL LIST', args: '' },
  { name: 'MODULE LIST', args: '' },
  { name: 'LATENCY LATEST', args: '' },
  { name: 'FLUSHDB', args: '[ASYNC | SYNC]' },
  { name: 'FLUSHALL', args: '[ASYNC | SYNC]' },

  // keyspace
  { name: 'KEYS', args: 'pattern' },
  { name: 'SCAN', args: 'cursor [MATCH pattern] [COUNT count] [TYPE type]' },
  { name: 'TYPE', args: 'key' },
  { name: 'EXISTS', args: 'key [key ...]' },
  { name: 'TTL', args: 'key' },
  { name: 'PTTL', args: 'key' },
  { name: 'EXPIRE', args: 'key seconds [NX | XX | GT | LT]' },
  { name: 'PEXPIRE', args: 'key milliseconds' },
  { name: 'EXPIREAT', args: 'key unix-time-seconds' },
  { name: 'PERSIST', args: 'key' },
  { name: 'RENAME', args: 'key newkey' },
  { name: 'RENAMENX', args: 'key newkey' },
  { name: 'DEL', args: 'key [key ...]' },
  { name: 'UNLINK', args: 'key [key ...]' },
  { name: 'DUMP', args: 'key' },
  { name: 'RESTORE', args: 'key ttl serialized-value [REPLACE]' },
  { name: 'RANDOMKEY', args: '' },
  { name: 'COPY', args: 'source destination [DB dest-db] [REPLACE]' },

  // string
  { name: 'GET', args: 'key' },
  { name: 'SET', args: 'key value [EX s | PX ms | KEEPTTL] [NX | XX] [GET]' },
  { name: 'SETEX', args: 'key seconds value' },
  { name: 'SETNX', args: 'key value' },
  { name: 'GETSET', args: 'key value' },
  { name: 'GETDEL', args: 'key' },
  { name: 'GETRANGE', args: 'key start end' },
  { name: 'SETRANGE', args: 'key offset value' },
  { name: 'STRLEN', args: 'key' },
  { name: 'APPEND', args: 'key value' },
  { name: 'MGET', args: 'key [key ...]' },
  { name: 'MSET', args: 'key value [key value ...]' },
  { name: 'INCR', args: 'key' },
  { name: 'DECR', args: 'key' },
  { name: 'INCRBY', args: 'key increment' },
  { name: 'INCRBYFLOAT', args: 'key increment' },

  // hash
  { name: 'HGET', args: 'key field' },
  { name: 'HSET', args: 'key field value [field value ...]' },
  { name: 'HSETNX', args: 'key field value' },
  { name: 'HDEL', args: 'key field [field ...]' },
  { name: 'HGETALL', args: 'key' },
  { name: 'HKEYS', args: 'key' },
  { name: 'HVALS', args: 'key' },
  { name: 'HLEN', args: 'key' },
  { name: 'HEXISTS', args: 'key field' },
  { name: 'HSTRLEN', args: 'key field' },
  { name: 'HINCRBY', args: 'key field increment' },
  { name: 'HSCAN', args: 'key cursor [MATCH pattern] [COUNT count] [NOVALUES]' },
  { name: 'HRANDFIELD', args: 'key [count [WITHVALUES]]' },

  // list
  { name: 'LPUSH', args: 'key element [element ...]' },
  { name: 'RPUSH', args: 'key element [element ...]' },
  { name: 'LPOP', args: 'key [count]' },
  { name: 'RPOP', args: 'key [count]' },
  { name: 'LRANGE', args: 'key start stop' },
  { name: 'LLEN', args: 'key' },
  { name: 'LINDEX', args: 'key index' },
  { name: 'LSET', args: 'key index element' },
  { name: 'LREM', args: 'key count element' },
  { name: 'LTRIM', args: 'key start stop' },
  { name: 'LINSERT', args: 'key BEFORE|AFTER pivot element' },
  { name: 'LPOS', args: 'key element [RANK rank] [COUNT count]' },
  { name: 'LMOVE', args: 'source destination LEFT|RIGHT LEFT|RIGHT' },

  // set
  { name: 'SADD', args: 'key member [member ...]' },
  { name: 'SREM', args: 'key member [member ...]' },
  { name: 'SMEMBERS', args: 'key' },
  { name: 'SCARD', args: 'key' },
  { name: 'SISMEMBER', args: 'key member' },
  { name: 'SMISMEMBER', args: 'key member [member ...]' },
  { name: 'SRANDMEMBER', args: 'key [count]' },
  { name: 'SPOP', args: 'key [count]' },
  { name: 'SSCAN', args: 'key cursor [MATCH pattern] [COUNT count]' },
  { name: 'SINTER', args: 'key [key ...]' },
  { name: 'SUNION', args: 'key [key ...]' },
  { name: 'SDIFF', args: 'key [key ...]' },

  // sorted set
  { name: 'ZADD', args: 'key [NX|XX] [GT|LT] [CH] [INCR] score member [score member ...]' },
  { name: 'ZREM', args: 'key member [member ...]' },
  { name: 'ZRANGE', args: 'key start stop [BYSCORE|BYLEX] [REV] [LIMIT offset count] [WITHSCORES]' },
  { name: 'ZRANGEBYSCORE', args: 'key min max [WITHSCORES] [LIMIT offset count]' },
  { name: 'ZSCORE', args: 'key member' },
  { name: 'ZMSCORE', args: 'key member [member ...]' },
  { name: 'ZCARD', args: 'key' },
  { name: 'ZCOUNT', args: 'key min max' },
  { name: 'ZRANK', args: 'key member [WITHSCORE]' },
  { name: 'ZINCRBY', args: 'key increment member' },
  { name: 'ZSCAN', args: 'key cursor [MATCH pattern] [COUNT count]' },
  { name: 'ZPOPMIN', args: 'key [count]' },
  { name: 'ZPOPMAX', args: 'key [count]' },

  // stream
  { name: 'XADD', args: 'key [NOMKSTREAM] [MAXLEN|MINID [=|~] threshold] *|id field value ...' },
  { name: 'XRANGE', args: 'key start end [COUNT count]' },
  { name: 'XREVRANGE', args: 'key end start [COUNT count]' },
  { name: 'XLEN', args: 'key' },
  { name: 'XDEL', args: 'key id [id ...]' },
  { name: 'XTRIM', args: 'key MAXLEN|MINID [=|~] threshold' },
  { name: 'XINFO STREAM', args: 'key [FULL [COUNT count]]' },
  { name: 'XINFO GROUPS', args: 'key' },
  { name: 'XINFO CONSUMERS', args: 'key group' },
  { name: 'XGROUP CREATE', args: 'key group id|$ [MKSTREAM]' },
  { name: 'XGROUP DESTROY', args: 'key group' },
  { name: 'XGROUP CREATECONSUMER', args: 'key group consumer' },
  { name: 'XACK', args: 'key group id [id ...]' },
  { name: 'XPENDING', args: 'key group [[IDLE ms] start end count [consumer]]' },
  { name: 'XCLAIM', args: 'key group consumer min-idle-time id [id ...] [JUSTID]' },
  { name: 'XAUTOCLAIM', args: 'key group consumer min-idle-time start [COUNT count] [JUSTID]' },

  // pub/sub
  { name: 'PUBLISH', args: 'channel message' },
  { name: 'PUBSUB CHANNELS', args: '[pattern]' },
  { name: 'PUBSUB NUMSUB', args: '[channel ...]' },

  // scripting
  { name: 'EVAL', args: 'script numkeys [key ...] [arg ...]' },
  { name: 'EVAL_RO', args: 'script numkeys [key ...] [arg ...]' },
  { name: 'EVALSHA', args: 'sha1 numkeys [key ...] [arg ...]' },
  { name: 'SCRIPT LOAD', args: 'script' },
  { name: 'FUNCTION LIST', args: '[LIBRARYNAME name] [WITHCODE]' },

  // RedisJSON
  { name: 'JSON.GET', args: 'key [INDENT i] [NEWLINE n] [SPACE s] [path ...]' },
  { name: 'JSON.SET', args: 'key path value [NX | XX]' },
  { name: 'JSON.DEL', args: 'key [path]' },
  { name: 'JSON.TYPE', args: 'key [path]' },
  { name: 'JSON.ARRLEN', args: 'key [path]' },
  { name: 'JSON.OBJKEYS', args: 'key [path]' },

  // RediSearch / TimeSeries (read side, enough to explore an index)
  { name: 'FT._LIST', args: '' },
  { name: 'FT.INFO', args: 'index' },
  { name: 'FT.SEARCH', args: 'index query [LIMIT offset num] [RETURN n field ...]' },
  { name: 'FT.AGGREGATE', args: 'index query [GROUPBY n property ...]' },
  { name: 'TS.INFO', args: 'key' },
  { name: 'TS.RANGE', args: 'key fromTimestamp toTimestamp [COUNT count]' },
];

/** Longest-first so `CONFIG GET` wins over `CONFIG` when both could match. */
const BY_LENGTH = [...COMMANDS].sort((a, b) => b.name.length - a.name.length);

/**
 * Auto-complete candidates for what the user has typed so far. Matches on the whole typed
 * prefix (so `xinfo g` finds `XINFO GROUPS`, not just `XINFO`).
 */
export function matchCommands(input: string, limit = 8): CommandEntry[] {
  const q = input.trimStart().toUpperCase();
  if (!q) return [];
  const out: CommandEntry[] = [];
  for (const c of COMMANDS) {
    if (c.name.startsWith(q)) out.push(c);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Syntax hint for the command already typed on the line, or `null` when it is not in the
 * table. Two-word names are checked first so `CONFIG SET x 1` hints the subcommand form.
 */
export function commandSyntax(input: string): CommandEntry | null {
  const text = input.trim().toUpperCase();
  if (!text) return null;
  return BY_LENGTH.find((c) => text === c.name || text.startsWith(`${c.name} `)) ?? null;
}
