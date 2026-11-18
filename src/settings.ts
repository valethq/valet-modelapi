import type { Disposable, PluginContext } from "@valethq/sdk";
import type { CustomModel, EndpointConfig, ModelApiConfig } from "./config";

type Ctx = PluginContext<ModelApiConfig>;

const isCustomModel = (m: unknown): m is CustomModel =>
  typeof m === "object" &&
  m !== null &&
  typeof (m as CustomModel).id === "string" &&
  (m as CustomModel).id.trim() !== "";

/** Panel value wins over config.json. Entries without an id are dropped. */
export function customModels(ctx: Ctx, ep: EndpointConfig): CustomModel[] {
  const v = ctx.storage.kv.get<unknown>(`customModels:${ep.id}`) ?? ep.customModels;
  return Array.isArray(v)
    ? v
        .filter(isCustomModel)
        .map(({ id, name }) => ({ id: id.trim(), ...(name?.trim() && { name: name.trim() }) }))
    : [];
}

export function provideSettings(ctx: Ctx, ep: EndpointConfig): Disposable {
  return ctx.scopes.provide(
    "settings",
    {
      title: ep.label ?? ep.id,
      description: `Overrides plugins.valet-modelapi.config for endpoint "${ep.id}".`,
      schema: {
        type: "object",
        properties: {
          customModels: {
            type: "array",
            title: "Custom models",
            description: "Extra models for the picker. The model name is sent to the endpoint as is.",
            items: {
              type: "object",
              required: ["id"],
              properties: {
                id: { type: "string", title: "Model name" },
                name: { type: "string", title: "Friendly name" },
              },
            },
          },
        },
      },
      get: () => ({ customModels: customModels(ctx, ep) }),
      set: (v) => {
        if (v.customModels === undefined) return;
        if (!(Array.isArray(v.customModels) && v.customModels.every(isCustomModel)))
          throw new Error("customModels entries need a model name");
        ctx.storage.kv.set(`customModels:${ep.id}`, v.customModels);
      },
    },
    { key: `valet-modelapi:${ep.id}` },
  );
}
