# 🚀 Complete Embedding Backfill Guide

## Overview

The enhanced backfill script now processes **ALL** ProductVariants with:

- **🖼️ Image Embeddings**: Products with images (SigLIP)
- **📝 Text Embeddings**: Products with titles/descriptions (Qwen3)
- **🔗 Combined Embeddings**: Products with both (weighted average: 70% image, 30% text)

## Quick Start

### 1. **Process All Your Products**
```bash
cd sssync-bknd
npm run backfill:embeddings
```

### 2. **Process Large Dataset (Recommended)**
```bash
# Process 100 products per batch, up to 20 batches (2000 products total)
BATCH_SIZE=100 MAX_BATCHES=20 npm run backfill:embeddings
```

### 3. **Reprocess Everything (Overwrite Existing)**
```bash
# Useful if you want to regenerate embeddings with new models
SKIP_EXISTING=false BATCH_SIZE=50 MAX_BATCHES=10 npm run backfill:embeddings
```

## Configuration Options

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `BATCH_SIZE` | 150 | Products processed per batch |
| `MAX_BATCHES` | 3 | Maximum number of batches |
| `SKIP_EXISTING` | true | Skip products that already have embeddings |
| `EMBEDDING_SERVER_URL` | Modal URL | Your AI server endpoint |

## Expected Output

```
🚀 Starting embedding backfill process...
Configuration:
  - Batch size: 100
  - Max batches: 10
  - Skip existing: true
  - Embedding server: https://your-modal-url

📦 Processing batch 1/10
Found 100 products to process

🔄 Processing: iPhone 13 Pro
📋 Content: Has text, Has image
🖼️  Processing image: https://example.com/iphone.jpg
✅ Image converted to base64 (87432 chars)
✅ Image embedding: 768 dimensions
📝 Processing text: "iPhone 13 Pro - The most advanced iPhone..."
✅ Text embedding: 1024 dimensions
✅ Combined embedding: 768 dimensions
✅ Stored embeddings (image, text, combined) for: iPhone 13 Pro

🔄 Processing: MacBook Air
📋 Content: Has text, No image
📝 Processing text: "MacBook Air - Incredibly thin and light..."
✅ Text embedding: 1024 dimensions
✅ Using text embedding as combined
✅ Stored embeddings (text, combined) for: MacBook Air

🎉 Backfill completed!

📊 Results:
  - Total products found: 1000
  - Successfully embedded: 980
  - Skipped: 20
  - Success rate: 98.0%

📈 Embedding Breakdown:
  - Image embeddings: 650
  - Text embeddings: 950
  - Combined embeddings: 980

🔍 Your quick scans should now find matches!
```

## Performance Tips

### 🚀 **Optimal Settings for Large Datasets**
```bash
# For 1000+ products
BATCH_SIZE=50 MAX_BATCHES=50 npm run backfill:embeddings
```

### ⚡ **Fast Processing (Small Batches)**
```bash
# Smaller batches = more frequent progress updates
BATCH_SIZE=25 MAX_BATCHES=10 npm run backfill:embeddings
```

### 🔄 **Resume from Where You Left Off**
```bash
# The script automatically skips existing embeddings
# Just run again with SKIP_EXISTING=true (default)
npm run backfill:embeddings
```

## Troubleshooting

### **Issue: 422 Unprocessable Entity Errors**
- **Cause**: Image format issues or server problems
- **Solution**: Script automatically skips failed images and continues

### **Issue: Text Embedding Failures**
- **Cause**: Very long product descriptions or special characters
- **Solution**: Script truncates and normalizes text automatically

### **Issue: No Embeddings Generated**
- **Check**: Your Modal AI server is running and accessible
- **Verify**: Environment variables are set correctly

### **Issue: Slow Performance**
- **Reduce BATCH_SIZE**: Use 25-50 for more responsive processing
- **Check AI Server**: Cold starts cause delays (50+ seconds initially)

## Database Results

After running, check your `ProductEmbeddings` table:

```sql
-- See total embeddings created
SELECT 
  COUNT(*) as total_embeddings,
  COUNT("ImageEmbedding") as image_count,
  COUNT("TextEmbedding") as text_count,
  COUNT("CombinedEmbedding") as combined_count
FROM "ProductEmbeddings";

-- See embedding sources
SELECT "SourceType", COUNT(*) as count
FROM "ProductEmbeddings" 
GROUP BY "SourceType";
```

## Next Steps

1. **✅ Test Quick Scan**: Your quick scans should now find matches!
2. **✅ Monitor Performance**: Response times should be much faster
3. **✅ Scale Up**: Increase batch sizes once everything is working

## Advanced Usage

### **Process Specific Product Range**
```bash
# Modify the script to add WHERE clauses for specific products
# Example: Only process products from last month
```

### **Custom Embedding Weights**
The script uses **70% image, 30% text** for combined embeddings. To change this, modify lines 190-194 in the script.

### **Multi-Modal Search Testing**
```bash
# Test your embeddings work
curl -X POST "your-api/products/orchestrate/quick-scan" \
  -H "Content-Type: application/json" \
  -d '{"imageUrl": "https://example.com/test-product.jpg"}'
```

---

**🎯 Goal**: Get all your products embedded so quick scans find matches instead of returning empty results!

**📈 Success Metric**: Response changes from `"matches": []` to `"matches": [...]` with actual product suggestions.