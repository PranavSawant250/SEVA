const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'seva.db');
const backupPath = path.join(__dirname, '..', 'seva.db.backup');

try {
  if (!fs.existsSync(dbPath)) {
    console.error('❌ Error: seva.db does not exist at path:', dbPath);
    process.exit(1);
  }

  // Copy seva.db to seva.db.backup
  fs.copyFileSync(dbPath, backupPath);
  const stats = fs.statSync(backupPath);
  console.log(`✅ Backup successfully created at: ${backupPath}`);
  console.log(`📊 Backup file size: ${(stats.size / 1024).toFixed(2)} KB`);

  // If WAL or SHM files exist, back them up as well
  const walPath = path.join(__dirname, '..', 'seva.db-wal');
  const shmPath = path.join(__dirname, '..', 'seva.db-shm');
  
  if (fs.existsSync(walPath)) {
    fs.copyFileSync(walPath, path.join(__dirname, '..', 'seva.db-wal.backup'));
    console.log('✅ WAL journal file backed up.');
  }
  if (fs.existsSync(shmPath)) {
    fs.copyFileSync(shmPath, path.join(__dirname, '..', 'seva.db-shm.backup'));
    console.log('✅ Shared memory file backed up.');
  }

  console.log('🎉 Database backup complete!');
} catch (error) {
  console.error('❌ Failed to create database backup:', error.message);
  process.exit(1);
}
