import fs from 'fs';
import path from 'path';
import { validateCouncilContext } from './from_orchestrator/mcp/contextValidation.ts';
import { runCouncilConsultation } from './from_orchestrator/engine/council.ts';
import { initSchema } from './from_orchestrator/db/database.ts';

async function main() {
  try {
    console.log("Initializing database schema...");
    initSchema();

    console.log("Reading data-science-ml-template files...");
    const templateDir = "/home/harry/Documents/Github-Projects/personal-projects/data-science-ml-template";
    const featuresContent = fs.readFileSync(path.join(templateDir, "src/features.py"), "utf8");
    const evaluationContent = fs.readFileSync(path.join(templateDir, "src/evaluation.py"), "utf8");
    const preprocessingContent = fs.readFileSync(path.join(templateDir, "src/preprocessing.py"), "utf8");

    // Construct CouncilContext manually to bypass Scout root limitations
    const context = {
      files: [
        {
          path: "src/features.py",
          content: featuresContent,
          relevance: "Defines Feature, FeaturePipeline, and concrete features"
        },
        {
          path: "src/evaluation.py",
          content: evaluationContent,
          relevance: "Defines VIF and mutual information scores"
        },
        {
          path: "src/preprocessing.py",
          content: preprocessingContent,
          relevance: "Defines preprocessors and ColumnTransformers"
        }
      ],
      structured_review: {
        review_objective: "Improve feature selection and pruning in the template repository.",
        architecture: "Tabular data science template with modular features, feature pipeline, and scikit-learn compatible preprocessors.",
        execution_flow: "Load data -> split -> preprocess -> train estimators -> evaluate and run diagnostics.",
        assumptions_and_invariants: "Scikit-learn BaseEstimator and TransformerMixin compatibility must be preserved. Avoid selection bias.",
        core_evidence: "src/features.py, src/evaluation.py, src/preprocessing.py",
        supporting_contracts: "src/project_config.py, src/pipeline.py",
        privacy_and_persistence: "No sensitive data. joblib model persistence.",
        tests_and_runtime_evidence: "None",
        omitted_material: "CLI and configuration utilities."
      }
    };

    console.log("Validating council context...");
    const validatedContext = validateCouncilContext(context, "how to improve feature selection and feature pruning");

    console.log("Starting Council Consultation...");
    const question = "How can we improve the feature selection and feature pruning parts of this repository? Suggest specific, concrete implementations for advanced feature selection/pruning methods, compliance with scikit-learn transformers, and integration into the features/pipeline architecture.";
    
    const result = await runCouncilConsultation({
      question,
      context: validatedContext
    });

    console.log("\n=================== COUNCIL REPORT ===================");
    console.log(result.report);
    console.log("======================================================\n");
    
    console.log("Consultation completed successfully!");
  } catch (err) {
    console.error("Critical error in council run:", err);
  }
}

main();
