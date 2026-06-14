import { OrchestrationRunner } from './runner.ts';
import type { SessionPoolItem } from './runner.ts';
import { DBService } from '../db/database.ts';
import { config } from '../config/index.ts';

/**
 * Multi-LLM Debate Orchestrator Engine.
 * Chains multiple LLM providers together to debate a specific topic,
 * recursively linking their logical rebuttals inside the SQLite lineage DAG.
 */
export async function runDebate(
  topic: string,
  roundsCount: number = 3,
  providers: string[] = ['chatgpt', 'gemini', 'claude']
): Promise<void> {
  console.log('\n============================================================');
  console.log('        🎙️ MULTI-LLM AGENT DEBATE INITIATED 🎙️');
  console.log(`Topic: "${topic}"`);
  console.log(`Rounds: ${roundsCount} | Debaters: ${providers.map(p => p.toUpperCase()).join(', ')}`);
  console.log('============================================================\n');

  const runId = `debate_run_${Date.now()}`;
  const debateHistory: { provider: string; taskId: string; argument: string }[] = [];
  const pagePool: Record<string, SessionPoolItem> = {};

  let previousTaskId: string | null = null;

  try {
    for (let round = 0; round < roundsCount; round++) {
      const currentProvider = providers[round % providers.length];
      const currentTaskId = `debate_task_r${round + 1}_${currentProvider}_${Date.now()}`;

      console.log(`\n[ROUND ${round + 1}/${roundsCount}] 🎤 ${currentProvider.toUpperCase()} is formulating an argument...`);

      // Initialize keep-alive pool item for this provider if not present
      if (!pagePool[currentProvider]) {
        pagePool[currentProvider] = { browser: null, context: null, page: null, hasActiveThread: false };
      }
      const poolItem = pagePool[currentProvider];

      // 1. Build prompt based on debate context & page keep-alive history
      let prompt = '';

      const lastProviderRoundIdx = debateHistory.map(h => h.provider).lastIndexOf(currentProvider);

      if (lastProviderRoundIdx === -1) {
        // First time this provider is speaking in this debate session
        if (round === 0) {
          // Absolute first round of the debate
          prompt = `You are a debater participating in a panel debate on the topic: "${topic}".`;
        } else {
          // First time this provider speaks, but other rounds have occurred. Load full history up to now.
          const historySummary = debateHistory
            .map((h, idx) => `Round ${idx + 1} (${h.provider.toUpperCase()}): "${h.argument}"`)
            .join('\n');

          prompt = `You are a debater participating in a panel debate on the topic: "${topic}".\n` +
            `Here is the debate history so far:\n${historySummary}`;
        }
      } else {
        // This provider has already spoken. Its open browser tab already contains context up to its last turn.
        // We only feed it new arguments formulated by other opponents since its own last turn!
        const newArguments = debateHistory.slice(lastProviderRoundIdx + 1);
        const newHistorySummary = newArguments
          .map((h) => `${h.provider.toUpperCase()} said:\n"${h.argument}"`)
          .join('\n\n');

        prompt = `The debate has continued. Here are the arguments since your last turn:\n\n` +
          `${newHistorySummary}`;
      }

      // 2. Instantiate and run orchestrator for this model with page pool item
      const runner = new OrchestrationRunner(runId, currentTaskId, currentProvider);

      const argument = await runner.executeTask(prompt, poolItem);

      console.log(`\n💬 ${currentProvider.toUpperCase()} says:\n"${argument}"\n`);

      // Mark that this provider has an active chat thread open
      poolItem.hasActiveThread = true;

      // Record in local session history
      debateHistory.push({
        provider: currentProvider,
        taskId: currentTaskId,
        argument
      });

      // 3. Link lineage to the previous debater's task (if any)
      if (previousTaskId) {
        console.log(`🔗 Linking lineage DAG: Parent [${previousTaskId}] -> Child [${currentTaskId}]`);
        DBService.addLineage(previousTaskId, currentTaskId);
      }

      previousTaskId = currentTaskId;

      // Cooldown to simulate thinking and permit DB locks release
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    console.log('\n============================================================');
    console.log('        🎉 DEBATE COMPLETED SUCCESSFULLY 🎉');
    console.log('============================================================');
    console.log('\nFinal Debate Transcript:\n');
    debateHistory.forEach((h, idx) => {
      console.log(`Round ${idx + 1} [${h.provider.toUpperCase()}] (Task ID: ${h.taskId}):`);
      console.log(`"${h.argument}"\n`);
    });
    console.log('============================================================');
    console.log('To trace the logical path of this debate inside the database,');
    console.log('copy the final Task ID and paste it into Menu Option 4 (Recursive Provenance).');
    console.log('============================================================\n');

  } catch (err: any) {
    console.error(`❌ Debate interrupted: ${err.message}`);
    throw err;
  } finally {
    // Keep browser sessions open after debate end as requested by the user
    console.log('\n[INFO] Keeping all active debate browser sessions open for visual inspection.\n');
  }
}
