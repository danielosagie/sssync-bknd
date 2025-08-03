import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface ProductVariant {
  Id: string;
  ProductId: string;
  Title: string;
  Description: string;
  ProductImages: { ImageUrl: string }[];
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Initialize Supabase client
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Get batch size from query params (default 10)
    const url = new URL(req.url)
    const batchSize = parseInt(url.searchParams.get('batchSize') || '10')
    const maxBatches = parseInt(url.searchParams.get('maxBatches') || '5')

    console.log(`Starting embedding backfill: ${batchSize} products per batch, max ${maxBatches} batches`)

    let totalProcessed = 0
    let totalEmbedded = 0
    let batchNumber = 0

    while (batchNumber < maxBatches) {
      batchNumber++
      console.log(`Processing batch ${batchNumber}/${maxBatches}`)

      // Get products that don't have embeddings
      const { data: products, error: fetchError } = await supabaseClient
        .from('ProductVariants')
        .select(`
          Id, ProductId, Title, Description,
          ProductImages!inner(ImageUrl)
        `)
        .not('Id', 'in', 
          `(SELECT "ProductVariantId" FROM "ProductEmbeddings" WHERE "ProductVariantId" IS NOT NULL)`
        )
        .limit(batchSize)

      if (fetchError) {
        console.error('Failed to fetch products:', fetchError)
        throw fetchError
      }

      if (!products || products.length === 0) {
        console.log('No more products need embeddings')
        break
      }

      console.log(`Found ${products.length} products needing embeddings`)
      totalProcessed += products.length

      // Process each product
      for (const product of products as ProductVariant[]) {
        try {
          const imageUrl = product.ProductImages?.[0]?.ImageUrl
          const textContent = [product.Title, product.Description].filter(Boolean).join(' ')

          if (!imageUrl && !textContent) {
            console.log(`Skipping product ${product.Id} - no image or text`)
            continue
          }

          // Call your embedding API
          const embeddingResponse = await fetch(`${Deno.env.get('EMBEDDING_SERVER_URL')}/embed/multimodal`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              image_url: imageUrl,
              text: textContent,
              instruction: `Encode this ecommerce product for similarity search. Focus on product features, use cases, target audience, and comparable alternatives.`
            })
          })

          if (!embeddingResponse.ok) {
            console.error(`Failed to generate embedding for product ${product.Id}`)
            continue
          }

          const embeddingData = await embeddingResponse.json()

          // Store the embedding
          const { error: storeError } = await supabaseClient
            .from('ProductEmbeddings')
            .upsert({
              ProductId: product.ProductId,
              ProductVariantId: product.Id,
              ImageEmbedding: embeddingData.image_embedding,
              TextEmbedding: embeddingData.text_embedding,
              CombinedEmbedding: embeddingData.combined_embedding || embeddingData.image_embedding,
              ImageUrl: imageUrl,
              ProductText: textContent,
              SourceType: 'backfill',
              BusinessTemplate: 'General Products',
              ModelVersions: {
                siglip: "google/siglip-large-patch16-384",
                qwen3: "Qwen/Qwen3-Embedding-0.6B"
              }
            })

          if (storeError) {
            console.error(`Failed to store embedding for product ${product.Id}:`, storeError)
          } else {
            totalEmbedded++
            console.log(`✅ Stored embedding for: ${product.Title}`)
          }

          // Small delay to avoid overwhelming the embedding server
          await new Promise(resolve => setTimeout(resolve, 100))

        } catch (error) {
          console.error(`Failed to process product ${product.Id}:`, error)
        }
      }

      // Break if this was a partial batch (no more products)
      if (products.length < batchSize) {
        console.log('Reached end of products')
        break
      }
    }

    const result = {
      success: true,
      message: `Backfill completed: ${totalEmbedded}/${totalProcessed} products embedded across ${batchNumber} batches`,
      stats: {
        totalProcessed,
        totalEmbedded,
        batchesProcessed: batchNumber,
        successRate: totalProcessed > 0 ? (totalEmbedded / totalProcessed * 100).toFixed(1) + '%' : '0%'
      }
    }

    console.log('Backfill completed:', result)

    return new Response(
      JSON.stringify(result),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200 
      }
    )

  } catch (error) {
    console.error('Backfill failed:', error)
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: error.message,
        message: 'Backfill process failed'
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500 
      }
    )
  }
})