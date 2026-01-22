import { getPool } from './src/db/postgres.js';

async function checkConstraints() {
  const pool = getPool();

  // Check constraints on sale_events table
  const result = await pool.query(`
    SELECT 
      conname as constraint_name,
      contype as constraint_type,
      pg_get_constraintdef(oid) as definition
    FROM pg_constraint
    WHERE conrelid = 'sale_events'::regclass
  `);

  console.log('Constraints on sale_events table:');
  result.rows.forEach(row => {
    console.log(`\nName: ${row.constraint_name}`);
    console.log(`Type: ${row.constraint_type}`);
    console.log(`Definition: ${row.definition}`);
  });

  // Check indexes
  const indexResult = await pool.query(`
    SELECT 
      indexname,
      indexdef
    FROM pg_indexes
    WHERE tablename = 'sale_events'
  `);

  console.log('\n\nIndexes on sale_events table:');
  indexResult.rows.forEach(row => {
    console.log(`\n${row.indexname}:`);
    console.log(`  ${row.indexdef}`);
  });
  
  // Check a sample of recent sales to see what data looks like
  const sampleResult = await pool.query(`
    SELECT product_id, sold_at, condition, variant, price, created_at
    FROM sale_events
    WHERE created_at > NOW() - INTERVAL '1 hour'
    ORDER BY created_at DESC
    LIMIT 10
  `);
  
  console.log('\n\nRecent sales (last hour):');
  sampleResult.rows.forEach(row => {
    console.log(`\nProduct: ${row.product_id}`);
    console.log(`  Sold: ${row.sold_at}`);
    console.log(`  Condition: ${row.condition}`);
    console.log(`  Variant: ${row.variant}`);
    console.log(`  Price: $${row.price}`);
    console.log(`  Created: ${row.created_at}`);
  });

  await pool.end();
}

checkConstraints().catch(console.error);
