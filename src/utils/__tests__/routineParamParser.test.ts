import { describe, it, expect } from 'vitest';
import { parseRoutineParameters, getDefaultValueForType } from '../routineParamParser';

describe('parseRoutineParameters', () => {
  it('should parse MySQL routine with IN and OUT parameters correctly', () => {
    const ddl = `
      CREATE DEFINER=\`root\`@\`localhost\` PROCEDURE \`film_not_in_stock\`(
        IN p_film_id INT,
        IN p_store_id INT,
        OUT p_film_count INT
      )
      READS SQL DATA
      BEGIN
        SELECT inventory_id FROM inventory WHERE film_id = p_film_id;
      END
    `;

    const params = parseRoutineParameters(ddl);
    expect(params).toHaveLength(3);
    expect(params[0]).toEqual({ mode: 'IN', name: 'p_film_id', type: 'INT' });
    expect(params[1]).toEqual({ mode: 'IN', name: 'p_store_id', type: 'INT' });
    expect(params[2]).toEqual({ mode: 'OUT', name: 'p_film_count', type: 'INT' });
  });

  it('should parse PostgreSQL procedure parameters correctly', () => {
    const ddl = `
      CREATE OR REPLACE PROCEDURE "transfer_funds"(
        "p_sender_id" INT,
        "p_receiver_id" INT,
        INOUT "p_amount" NUMERIC
      )
      LANGUAGE plpgsql
      AS $$
      BEGIN
        NULL;
      END;
      $$;
    `;

    const params = parseRoutineParameters(ddl);
    expect(params).toHaveLength(3);
    expect(params[0]).toEqual({ mode: 'IN', name: 'p_sender_id', type: 'INT' });
    expect(params[1]).toEqual({ mode: 'IN', name: 'p_receiver_id', type: 'INT' });
    expect(params[2]).toEqual({ mode: 'INOUT', name: 'p_amount', type: 'NUMERIC' });
  });

  it('should return empty array for parameterless routine', () => {
    const ddl = `CREATE PROCEDURE \`clear_logs\`() BEGIN DELETE FROM logs; END`;
    const params = parseRoutineParameters(ddl);
    expect(params).toHaveLength(0);
  });
});


describe('getDefaultValueForType', () => {
  it('should generate smart defaults based on parameter type', () => {
    expect(getDefaultValueForType('DATETIME')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(getDefaultValueForType('DATE')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(getDefaultValueForType('VARCHAR(255)')).toBe('test');
    expect(getDefaultValueForType('INT')).toBe('1');
  });
});
