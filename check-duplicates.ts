import { getPool } from './src/db/postgres.js';

async function checkDuplicates() {
  const pool = getPool();

  // Check for potential duplicate sales (same product, similar time, same price)
  const result = await pool.query(`
    SELECT 
      product_id,
      DATE(sold_at) as sale_date,
      condition,
      price,
      COUNT(*) as sale_count,
      ARRAY_AGG(sold_at ORDER BY sold_at) as timestamps,
      ARRAY_AGG(created_at ORDER BY created_at) as created_timestamps
    FROM sale_events
    WHERE created_at > NOW() - INTERVAL '2 hours'
    GROUP BY product_id, DATE(sold_at), condition, price
    HAVING COUNT(*) > 1
    ORDER BY sale_count DESC
    LIMIT 20
  `);

  console.log('Potential duplicate sales (same product, date, condition, price but different timestamps):');
  console.log(`Found ${result.rows.length} groups\n`);
  
  result.rows.forEach(row => {
    console.log(`Product ${row.product_id} - ${row.condition} - $${row.price}`);
    console.log(`  Date: ${row.sale_date}`);
    console.log(`  Count: ${row.sale_count} sales`);
    console.log(`  Sold timestamps:`);
    row.timestamps.forEach((ts: Date) => {
      console.log(`    ${ts}`);
    });
    console.log('');
  });

  // Check total sales in last 2 hours
  const countResult = await pool.query(`
    SELECT COUNT(*) as total
    FROM sale_events
    WHERE created_at > NOW() - INTERVAL '2 hours'
  `);
  
  console.log(`\nTotal sales inserted in last 2 hours: ${countResult.rows[0].total}`);

  // Check if there are older sales for the same products
  const oldSalesResult = await pool.query(`
    SELECT 
      product_id,
      COUNT(*) as old_sales,
      MIN(created_at) as first_seen,
      MAX(created_at) as last_seen
    FROM sale_events
    WHERE product_id IN (
      SELECT DISTINCT product_id 
      FROM sale_events 
      WHERE created_at > NOW() - INTERVAL '2 hours'
    )
    AND created_at < NOW() - INTERVAL '2 hours'
    GROUP BY product_id
    ORDER BY old_sales DESC
    LIMIT 10
  `);

  console.log('\nProducts with older sales (should have matched duplicates):');
  oldSalesResult.rows.forEach(row => {
    console.log(`Product ${row.product_id}: ${row.old_sales} older sales (first: ${row.first_seen}, last: ${row.last_seen})`);
  });

  await pool.end();
}

checkDuplicates().catch(console.error);
