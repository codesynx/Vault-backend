/**
 * Script to clean up duplicate messages caused by the double-archiving bug
 *
 * The bug: Outgoing messages were archived twice - once in updateNewMessage with
 * a TDLib temp ID (very large number like 4398046511169), and again in
 * updateMessageSendSucceeded with the real Telegram ID (smaller sequential number).
 *
 * This script identifies and removes the duplicate entries with temp IDs.
 *
 * Usage: npx tsx scripts/cleanup-duplicate-messages.ts [--dry-run]
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function cleanupDuplicates(dryRun = true) {
  console.log(`\n🔍 Scanning for duplicate messages...${dryRun ? ' (DRY RUN)' : ''}\n`);

  // Find all outgoing messages
  const outgoingMessages = await prisma.message.findMany({
    where: {
      isOutgoing: true,
    },
    select: {
      id: true,
      chatId: true,
      senderId: true,
      telegramMessageId: true,
      content: true,
      telegramCreatedAt: true,
    },
    orderBy: [
      { chatId: 'asc' },
      { telegramCreatedAt: 'asc' },
    ],
  });

  console.log(`Found ${outgoingMessages.length} total outgoing messages\n`);

  // Group by (chatId, senderId, content) to find potential duplicates
  const groups = new Map<string, typeof outgoingMessages>();

  for (const msg of outgoingMessages) {
    const key = `${msg.chatId}_${msg.senderId}_${msg.content}`;
    const group = groups.get(key) || [];
    group.push(msg);
    groups.set(key, group);
  }

  // Find groups with duplicates (more than one message with same content)
  const duplicatesToDelete: string[] = [];
  const TEMP_ID_THRESHOLD = BigInt('4000000000000'); // TDLib temp IDs are typically > 4 trillion

  for (const [key, messages] of groups) {
    if (messages.length <= 1) continue;

    // Sort by telegramMessageId to identify temp vs real IDs
    const sorted = [...messages].sort((a, b) => {
      const aId = BigInt(a.telegramMessageId);
      const bId = BigInt(b.telegramMessageId);
      if (aId < bId) return -1;
      if (aId > bId) return 1;
      return 0;
    });

    // Check if we have both temp and real IDs
    const tempIds = sorted.filter(m => BigInt(m.telegramMessageId) > TEMP_ID_THRESHOLD);
    const realIds = sorted.filter(m => BigInt(m.telegramMessageId) <= TEMP_ID_THRESHOLD);

    // Only delete temp ID messages if we also have a real ID version
    if (tempIds.length > 0 && realIds.length > 0) {
      // Verify messages are within 60 seconds of each other
      for (const tempMsg of tempIds) {
        for (const realMsg of realIds) {
          const timeDiff = Math.abs(
            tempMsg.telegramCreatedAt.getTime() - realMsg.telegramCreatedAt.getTime()
          );

          if (timeDiff < 60000) { // Within 60 seconds
            console.log(`📋 Found duplicate in chat ${tempMsg.chatId}:`);
            console.log(`   Content: "${tempMsg.content.slice(0, 50)}${tempMsg.content.length > 50 ? '...' : ''}"`);
            console.log(`   Temp ID: ${tempMsg.telegramMessageId} (to delete)`);
            console.log(`   Real ID: ${realMsg.telegramMessageId} (to keep)`);
            console.log();

            duplicatesToDelete.push(tempMsg.id);
          }
        }
      }
    }
  }

  console.log(`\n📊 Summary:`);
  console.log(`   Total duplicates found: ${duplicatesToDelete.length}`);

  if (duplicatesToDelete.length === 0) {
    console.log('\n✅ No duplicates to clean up!\n');
    return;
  }

  if (dryRun) {
    console.log(`\n⚠️  DRY RUN - No changes made.`);
    console.log(`   Run with --delete flag to actually remove duplicates.\n`);
  } else {
    console.log(`\n🗑️  Deleting ${duplicatesToDelete.length} duplicate messages...`);

    const result = await prisma.message.deleteMany({
      where: {
        id: { in: duplicatesToDelete },
      },
    });

    console.log(`✅ Deleted ${result.count} duplicate messages!\n`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--delete');

  if (dryRun) {
    console.log('\n💡 Running in DRY RUN mode. Use --delete flag to actually remove duplicates.\n');
  } else {
    console.log('\n⚠️  Running in DELETE mode. This will permanently remove duplicate messages.\n');
  }

  try {
    await cleanupDuplicates(dryRun);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
