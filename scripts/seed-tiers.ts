import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';
import tiersConfig from '../src/config/subscription-tiers.config.json'; // Adjust path if needed

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const supabaseUrl = process.env.SUPABASE_URL;
// IMPORTANT: Use the Service Role Key for seeding to bypass RLS if necessary
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error(
    'Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in environment variables.',
  );
  process.exit(1);
}

// Initialize Supabase client
const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function seedTiers() {
  console.log('Attempting to seed subscription tiers...');

  // Map the JSON config to the database column names
  // Ensure your DB column names match these keys exactly (case-sensitive in PostgreSQL)
  const upserts = tiersConfig.map((tier) => ({
    Id: tier.Id,
    Name: tier.Name,
    PriceMonthly: tier.PriceMonthly,
    ProductLimit: tier.ProductLimit,
    SyncOperationLimit: tier.SyncOperationLimit,
    MarketplaceFeePercent: tier.MarketplaceFeePercent,
    OrderFeePercent: tier.OrderFeePercent,
    AllowsInterSellerMarketplace: tier.AllowsInterSellerMarketplace,
    AiScans: tier.AiScans, // Make sure this column exists in your DB table
  }));

  console.log(`Prepared ${upserts.length} tiers for upserting.`);
  // console.log('Data to upsert:', JSON.stringify(upserts, null, 2)); // Uncomment for debugging

  const { data, error } = await supabase
    .from('SubscriptionTiers') // Ensure this matches your table name
    .upsert(upserts, { onConflict: 'Id' }) // Upsert based on the Id PK
    .select(); // Optionally select the results

  if (error) {
    console.error('Error seeding/updating tiers:', error.message);
    if (error.details) console.error('Details:', error.details);
    if (error.hint) console.error('Hint:', error.hint);
    process.exit(1); // Exit with error code
  } else {
    console.log('Successfully seeded/updated SubscriptionTiers.');
    console.log('Upserted rows:', data?.length || 0);
  }
}

// Run the seeding function
seedTiers()
  .then(() => process.exit(0)) // Exit successfully
  .catch(() => process.exit(1)); // Exit with error if something unexpected happens
