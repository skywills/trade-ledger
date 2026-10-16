import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import {
  ModelConfigurationSchema,
  ProfileInputSchema,
  SelectDefaultSchema,
  UpdateProfileSchema,
} from "../../shared/api.js";
import { AppError } from "../../shared/errors.js";
import { testProfile } from "../ai/compatibility.js";
import type { SecretResolver } from "../ai/credentials.js";
import {
  defaultProfileId,
  importProfiles,
  type LlmProfile,
  listProfiles,
  readCompatibility,
  saveProfile,
  selectDefaultProfile,
} from "../ai/profiles.js";
import type { Store } from "../storage/database.js";

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new AppError("INVALID_INPUT", "Request body failed validation.", 400);
  }
  return result.data;
}

async function toView(
  store: Store,
  secrets: SecretResolver,
  profile: LlmProfile,
): Promise<Record<string, unknown>> {
  return {
    ...profile,
    credential: await secrets.status(profile.credentialRef, profile.mode),
    compatibility: readCompatibility(store, profile.id),
  };
}

/**
 * Retained/revisioned model-profile routes. Responses never carry a secret
 * value — only the credential source's configured/missing status. Mutations
 * are covered by the shared same-origin guard.
 */
export async function registerModelRoutes(
  app: FastifyInstance,
  store: Store,
  secrets: SecretResolver,
): Promise<void> {
  app.get("/api/models", async () => {
    const profiles = listProfiles(store);
    return {
      profiles: await Promise.all(
        profiles.map((profile) => toView(store, secrets, profile)),
      ),
      defaultProfileId: defaultProfileId(store),
    };
  });

  app.get("/api/models/configuration", async (_request, reply) => {
    const configuration = ModelConfigurationSchema.parse({
      version: 1,
      profiles: listProfiles(store).map((profile) =>
        ProfileInputSchema.parse(profile),
      ),
    });
    reply.header(
      "content-disposition",
      'attachment; filename="model-configuration.json"',
    );
    reply.header("cache-control", "no-store");
    return configuration;
  });

  app.post("/api/models/configuration", async (request, reply) => {
    const configuration = parse(ModelConfigurationSchema, request.body);
    const imported = await importProfiles(store, configuration.profiles);
    reply.code(201);
    return { imported };
  });

  app.post("/api/models", async (request, reply) => {
    const input = parse(ProfileInputSchema, request.body);
    const profile = await saveProfile(store, input, null);
    reply.code(201);
    return { profile: await toView(store, secrets, profile) };
  });

  app.put("/api/models/:id", async (request) => {
    const { id } = request.params as { id: string };
    const body = parse(UpdateProfileSchema, request.body);
    const { expectedRevision, ...input } = body;
    const profile = await saveProfile(
      store,
      { ...input, id },
      expectedRevision,
    );
    return { profile: await toView(store, secrets, profile) };
  });

  app.post("/api/models/default", async (request) => {
    const body = parse(SelectDefaultSchema, request.body);
    await selectDefaultProfile(store, body.id, {
      confirmCloud: body.confirmCloud === true,
    });
    return { defaultProfileId: defaultProfileId(store) };
  });

  app.post("/api/models/:id/test", async (request) => {
    const { id } = request.params as { id: string };
    const result = await testProfile(
      store,
      id,
      new AbortController().signal,
      secrets,
    );
    return {
      result: {
        ...readCompatibility(store, id),
        profileId: result.profileId,
        status: result.status,
        reason: result.reason,
        profileRevision: result.profileRevision,
        checkedAt: result.checkedAt,
        endpoint: result.endpoint,
        modelId: result.modelId,
        durationMs: result.durationMs,
      },
    };
  });
}
