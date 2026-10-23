import { ZodObject, ZodTypeAny } from 'zod/v4';
export declare class ZodMetaMap<MetaType = Record<string, unknown>> {
    private fieldMap;
    /**
     * Adds a Zod schema under a specific key (property name),
     * optionally attaching typed metadata.
     *
     * @param key - The name of the property in the root object.
     * @param schema - The Zod schema for that property.
     * @param metadata - Optional metadata object (type MetaType).
     */
    add<T extends ZodTypeAny>(key: string, schema: T, metadata?: MetaType): this;
    /**
     * Builds and returns a root Zod object
     * that combines all properties which were added.
     */
    root(): ZodObject<Record<string, ZodTypeAny>>;
    /**
     * Retrieves the metadata for a specific key, if any.
     */
    getMetadata(key: string): MetaType | undefined;
    /**
     * Static factory method: creates a SchemaMetaManager
     * while letting you optionally specify the MetaType.
     *
     * Usage:
     *   const manager = SchemaMetaManager.create<MyFieldMeta>();
     */
    static create<MT = Record<string, unknown>>(): ZodMetaMap<MT>;
    /**
     * Returns a basic UiSchema object that RJSF can use to render form controls.
     *
     * - Adds a top-level "ui:submitButtonOptions" (example).
     * - For each field, we set `ui:title` (uppercase key),
     *   `ui:description` (from Zod's .describe() if available),
     *   and a naive placeholder from the default value (if parse(undefined) succeeds).
     */
    getUISchema(): Record<string, unknown>;
}
