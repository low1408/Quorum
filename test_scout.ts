import { handleScoutDiscoverContext } from './from_orchestrator/mcp/server.ts';

async function test() {
  try {
    console.log("Calling handleScoutDiscoverContext with response_mode compact...");
    const result = await handleScoutDiscoverContext({
      query: "feature selection and feature pruning",
      repo_root: "/home/harry/Documents/Github-Projects/personal-projects/quorum-llm-council",
      response_mode: "compact"
    });
    console.log("Success! Result keys:", Object.keys(result));
    console.log("Result content text length:", result.content[0].text.length);
  } catch (err) {
    console.error("Caught error:", err);
  }
}

test();
