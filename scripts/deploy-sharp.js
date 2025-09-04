#!/usr/bin/env node

/**
 * Deployment script to ensure Sharp is properly installed for the target platform
 * This fixes the "Could not load the sharp module using the linux-x64 runtime" error
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('🔧 Starting Sharp deployment fix...');

try {
  // Check if we're in a Linux environment (typical for deployment)
  const platform = process.platform;
  const arch = process.arch;
  
  console.log(`📋 Platform: ${platform}, Architecture: ${arch}`);
  
  // Remove existing Sharp installation to ensure clean install
  const sharpPath = path.join(__dirname, '..', 'node_modules', 'sharp');
  if (fs.existsSync(sharpPath)) {
    console.log('🗑️  Removing existing Sharp installation...');
    execSync('npm uninstall sharp', { stdio: 'inherit', cwd: path.join(__dirname, '..') });
  }
  
  // Install Sharp with platform-specific flags
  if (platform === 'linux') {
    console.log('🐧 Installing Sharp for Linux...');
    execSync('npm install --platform=linux --arch=x64 sharp', { 
      stdio: 'inherit', 
      cwd: path.join(__dirname, '..') 
    });
  } else {
    console.log('💻 Installing Sharp for current platform...');
    execSync('npm install sharp', { 
      stdio: 'inherit', 
      cwd: path.join(__dirname, '..') 
    });
  }
  
  console.log('✅ Sharp installation completed successfully!');
  
  // Verify Sharp can be loaded
  try {
    const sharp = require('sharp');
    console.log('🎯 Sharp verification: OK');
  } catch (error) {
    console.error('❌ Sharp verification failed:', error.message);
    process.exit(1);
  }
  
} catch (error) {
  console.error('💥 Error during Sharp deployment fix:', error.message);
  process.exit(1);
}
