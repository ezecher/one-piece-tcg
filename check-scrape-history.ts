import { getPool } from './src/db/postgres.js';

async function checkScrapeHistory() {
  const pool = getPool();

  // Check recent scrape runs
  const runsResult = await pool.query(`
    SELECT 
      id,
      run_type,
      started_at,
      completed_at,
      status,
      products_scraped,
      new_sales
    FROM scrape_runs
    ORDER BY started_at DESC
    LIMIT 10
  `);

  console.log('Recent scrape runs:');
  runsResult.rows.forEach(row => {
    const duration = row.completed_at 
      ? Math.round((new Date(row.completed_at).getTime() - new Date(row.started_at).getTime()) / 1000)
      : 'in progress';
    console.log(`\nRun #${row.id} - ${row.run_type}`);
    console.log(`  Started: ${row.started_at}`);
    console.log(`  Status: ${row.status}`);
    console.log(`  Products: ${row.products_scraped || 0}`);
    console.log(`  New sales: ${row.new_sales || 0}`);
    console.log(`  Duration: ${duration}s`);
  });

  // Check when sales were created
  const salesTimingResult = await pool.query(`
    SELECT 
      DATE(created_at) as creation_date,
      COUNT(*) as sales_count,
      MIN(created_at) as first_created,
      MAX(created_at) as last_created
    FROM sale_events
    WHERE created_at > NOW() - INTERVAL '7 days'
    GROUP BY DATE(created_at)
    ORDER BY creation_date DESC
  `);

  console.log('\n\nSales creation by day (last 7 days):');
  salesTimingResult.rows.forEach(row => {
    console.log(`${row.creation_date}: ${row.sales_count} sales (${row.first_created} to ${row.last_created})`);
  });

  // Check if the API is returning MORE sales per product now
  const comparisonResult = await pool.query(`
    SELECT 
      product_id,
      COUNT(*) as total_sales,
      COUNT(CASE WHEN created_at > NOW() - INTERVAL '2 hours' THEN 1 END) as recent_sales,
      COUNT(CASE WHEN created_at < NOW() - INTERVAL '2 hours' THEN 1 END) as older_sales,
      MIN(created_at) as first_seen,
      MAX(created_at) as last_seen
    FROM sale_events
    WHERE product_id IN (
      SELECT DISTINCT product_id 
      FROM sale_events 
      WHERE created_at > NOW() - INTERVAL '2 hours'
      LIMIT 10
    )
    GROUP BY product_id
    ORDER BY recent_sales DESC
    LIMIT 10
  `);

  console.log('\n\nSample products - recent vs older sales:');
  comparisonResult.rows.forEach(row => {
    console.log(`\nProduct ${row.product_id}:`);
    console.log(`  Total: ${row.total_sales} sales`);
    console.log(`  Recent (last 2h): ${row.recent_sales} NEW sales`);
    console.log(`  Older: ${row.older_sales} existing sales`);
    console.log(`  First seen: ${row.first_seen}`);
    console.log(`  Last seen: ${row.last_seen}`);
  });

  await pool.end();
}

checkScrapeHistory().catch(console.error);
