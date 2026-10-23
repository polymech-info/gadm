import { z, ZodObject, ZodTypeAny } from 'zod/v4';
/*
* Manages a collection of Zod schema properties
 * and combines them into a single Zod object schema.
 *
 * @template MetaType The type of metadata you want to store for each field.
 *                    Defaults to Record<string, unknown> if not provided.
 */
export class ZodMetaMap<MetaType = Record<string, unknown>> {
    private fieldMap = new Map<
        string,
        { schema: ZodTypeAny; metadata?: MetaType }
    >();

    /**
     * Adds a Zod schema under a specific key (property name),
     * optionally attaching typed metadata.
     *
     * @param key - The name of the property in the root object.
     * @param schema - The Zod schema for that property.
     * @param metadata - Optional metadata object (type MetaType).
     */
    add<T extends ZodTypeAny>(key: string, schema: T, metadata?: MetaType): this {
        this.fieldMap.set(key, { schema, metadata });
        return this;
    }

    /**
     * Builds and returns a root Zod object
     * that combines all properties which were added.
     */
    root(): ZodObject<Record<string, ZodTypeAny>> {
        const shape: Record<string, ZodTypeAny> = {};
        for (const [key, { schema }] of this.fieldMap.entries()) {
            shape[key] = schema;
        }
        return z.object(shape);
    }

    /**
     * Retrieves the metadata for a specific key, if any.
     */
    getMetadata(key: string): MetaType | undefined {
        return this.fieldMap.get(key)?.metadata;
    }

    /**
     * Static factory method: creates a SchemaMetaManager
     * while letting you optionally specify the MetaType.
     *
     * Usage:
     *   const manager = SchemaMetaManager.create<MyFieldMeta>();
     */
    static create<MT = Record<string, unknown>>(): ZodMetaMap<MT> {
        return new ZodMetaMap<MT>();
    }

    /**
     * Returns a basic UiSchema object that RJSF can use to render form controls.
     *
     * - Adds a top-level "ui:submitButtonOptions" (example).
     * - For each field, we set `ui:title` (uppercase key),
     *   `ui:description` (from Zod's .describe() if available),
     *   and a naive placeholder from the default value (if parse(undefined) succeeds).
     */
    getUISchema(): Record<string, unknown> {
        // Start with some top-level UI schema config (optional)
        const uiSchema: Record<string, unknown> = {
            'ui:submitButtonOptions': {
                props: {
                    disabled: false,
                    className: 'btn btn-info',
                },
                norender: false,
                submitText: 'Submit',
            },
        };

        for (const [key, { schema }] of this.fieldMap.entries()) {
            let fieldUi: Record<string, unknown> = {};
            // Use the Zod description if available
            // (Accessing `._def.description` is private/hacky, but commonly done.)
            const sAny = schema as any;
            if (sAny?._def?.description) {
                fieldUi['ui:description'] = sAny._def.description;
            }

            // RJSF usually reads 'title' from JSON schema. But if you want
            // to override it in UI schema, you can do so:
            fieldUi['ui:title'] = key
                .replace(/([A-Z])/g, ' $1') // insert space before capital letters
                .replace(/^./, (str) => str.toUpperCase()) // capitalize the first letter
                .trim();

            // If the Zod schema allows a default, we can parse(undefined) to get it.
            try {
                const defaultVal = schema.parse(undefined);
                // There's no official 'ui:default' in RJSF, but you could do a placeholder:
                fieldUi['ui:placeholder'] = defaultVal;
            } catch {
                // no default
            }
            fieldUi = {
                ...fieldUi,
                ...this.getMetadata(key),
            }
            uiSchema[key] = fieldUi;
        }
        return uiSchema;
    }
}
