import { z } from 'zod/v4';
/*
* Manages a collection of Zod schema properties
 * and combines them into a single Zod object schema.
 *
 * @template MetaType The type of metadata you want to store for each field.
 *                    Defaults to Record<string, unknown> if not provided.
 */
export class ZodMetaMap {
    fieldMap = new Map();
    /**
     * Adds a Zod schema under a specific key (property name),
     * optionally attaching typed metadata.
     *
     * @param key - The name of the property in the root object.
     * @param schema - The Zod schema for that property.
     * @param metadata - Optional metadata object (type MetaType).
     */
    add(key, schema, metadata) {
        this.fieldMap.set(key, { schema, metadata });
        return this;
    }
    /**
     * Builds and returns a root Zod object
     * that combines all properties which were added.
     */
    root() {
        const shape = {};
        for (const [key, { schema }] of this.fieldMap.entries()) {
            shape[key] = schema;
        }
        return z.object(shape);
    }
    /**
     * Retrieves the metadata for a specific key, if any.
     */
    getMetadata(key) {
        return this.fieldMap.get(key)?.metadata;
    }
    /**
     * Static factory method: creates a SchemaMetaManager
     * while letting you optionally specify the MetaType.
     *
     * Usage:
     *   const manager = SchemaMetaManager.create<MyFieldMeta>();
     */
    static create() {
        return new ZodMetaMap();
    }
    /**
     * Returns a basic UiSchema object that RJSF can use to render form controls.
     *
     * - Adds a top-level "ui:submitButtonOptions" (example).
     * - For each field, we set `ui:title` (uppercase key),
     *   `ui:description` (from Zod's .describe() if available),
     *   and a naive placeholder from the default value (if parse(undefined) succeeds).
     */
    getUISchema() {
        // Start with some top-level UI schema config (optional)
        const uiSchema = {
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
            let fieldUi = {};
            // Use the Zod description if available
            // (Accessing `._def.description` is private/hacky, but commonly done.)
            const sAny = schema;
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
            }
            catch {
                // no default
            }
            fieldUi = {
                ...fieldUi,
                ...this.getMetadata(key),
            };
            uiSchema[key] = fieldUi;
        }
        return uiSchema;
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFwLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL21hcC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEVBQUUsQ0FBQyxFQUF5QixNQUFNLFFBQVEsQ0FBQztBQUNsRDs7Ozs7O0dBTUc7QUFDSCxNQUFNLE9BQU8sVUFBVTtJQUNYLFFBQVEsR0FBRyxJQUFJLEdBQUcsRUFHdkIsQ0FBQztJQUVKOzs7Ozs7O09BT0c7SUFDSCxHQUFHLENBQXVCLEdBQVcsRUFBRSxNQUFTLEVBQUUsUUFBbUI7UUFDakUsSUFBSSxDQUFDLFFBQVEsQ0FBQyxHQUFHLENBQUMsR0FBRyxFQUFFLEVBQUUsTUFBTSxFQUFFLFFBQVEsRUFBRSxDQUFDLENBQUM7UUFDN0MsT0FBTyxJQUFJLENBQUM7SUFDaEIsQ0FBQztJQUVEOzs7T0FHRztJQUNILElBQUk7UUFDQSxNQUFNLEtBQUssR0FBK0IsRUFBRSxDQUFDO1FBQzdDLEtBQUssTUFBTSxDQUFDLEdBQUcsRUFBRSxFQUFFLE1BQU0sRUFBRSxDQUFDLElBQUksSUFBSSxDQUFDLFFBQVEsQ0FBQyxPQUFPLEVBQUUsRUFBRSxDQUFDO1lBQ3RELEtBQUssQ0FBQyxHQUFHLENBQUMsR0FBRyxNQUFNLENBQUM7UUFDeEIsQ0FBQztRQUNELE9BQU8sQ0FBQyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUMzQixDQUFDO0lBRUQ7O09BRUc7SUFDSCxXQUFXLENBQUMsR0FBVztRQUNuQixPQUFPLElBQUksQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxFQUFFLFFBQVEsQ0FBQztJQUM1QyxDQUFDO0lBRUQ7Ozs7OztPQU1HO0lBQ0gsTUFBTSxDQUFDLE1BQU07UUFDVCxPQUFPLElBQUksVUFBVSxFQUFNLENBQUM7SUFDaEMsQ0FBQztJQUVEOzs7Ozs7O09BT0c7SUFDSCxXQUFXO1FBQ1Asd0RBQXdEO1FBQ3hELE1BQU0sUUFBUSxHQUE0QjtZQUN0Qyx3QkFBd0IsRUFBRTtnQkFDdEIsS0FBSyxFQUFFO29CQUNILFFBQVEsRUFBRSxLQUFLO29CQUNmLFNBQVMsRUFBRSxjQUFjO2lCQUM1QjtnQkFDRCxRQUFRLEVBQUUsS0FBSztnQkFDZixVQUFVLEVBQUUsUUFBUTthQUN2QjtTQUNKLENBQUM7UUFFRixLQUFLLE1BQU0sQ0FBQyxHQUFHLEVBQUUsRUFBRSxNQUFNLEVBQUUsQ0FBQyxJQUFJLElBQUksQ0FBQyxRQUFRLENBQUMsT0FBTyxFQUFFLEVBQUUsQ0FBQztZQUN0RCxJQUFJLE9BQU8sR0FBNEIsRUFBRSxDQUFDO1lBQzFDLHVDQUF1QztZQUN2Qyx1RUFBdUU7WUFDdkUsTUFBTSxJQUFJLEdBQUcsTUFBYSxDQUFDO1lBQzNCLElBQUksSUFBSSxFQUFFLElBQUksRUFBRSxXQUFXLEVBQUUsQ0FBQztnQkFDMUIsT0FBTyxDQUFDLGdCQUFnQixDQUFDLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxXQUFXLENBQUM7WUFDdEQsQ0FBQztZQUVELCtEQUErRDtZQUMvRCw4Q0FBOEM7WUFDOUMsT0FBTyxDQUFDLFVBQVUsQ0FBQyxHQUFHLEdBQUc7aUJBQ3BCLE9BQU8sQ0FBQyxVQUFVLEVBQUUsS0FBSyxDQUFDLENBQUMsc0NBQXNDO2lCQUNqRSxPQUFPLENBQUMsSUFBSSxFQUFFLENBQUMsR0FBRyxFQUFFLEVBQUUsQ0FBQyxHQUFHLENBQUMsV0FBVyxFQUFFLENBQUMsQ0FBQyw4QkFBOEI7aUJBQ3hFLElBQUksRUFBRSxDQUFDO1lBRVoseUVBQXlFO1lBQ3pFLElBQUksQ0FBQztnQkFDRCxNQUFNLFVBQVUsR0FBRyxNQUFNLENBQUMsS0FBSyxDQUFDLFNBQVMsQ0FBQyxDQUFDO2dCQUMzQyw0RUFBNEU7Z0JBQzVFLE9BQU8sQ0FBQyxnQkFBZ0IsQ0FBQyxHQUFHLFVBQVUsQ0FBQztZQUMzQyxDQUFDO1lBQUMsTUFBTSxDQUFDO2dCQUNMLGFBQWE7WUFDakIsQ0FBQztZQUNELE9BQU8sR0FBRztnQkFDTixHQUFHLE9BQU87Z0JBQ1YsR0FBRyxJQUFJLENBQUMsV0FBVyxDQUFDLEdBQUcsQ0FBQzthQUMzQixDQUFBO1lBQ0QsUUFBUSxDQUFDLEdBQUcsQ0FBQyxHQUFHLE9BQU8sQ0FBQztRQUM1QixDQUFDO1FBQ0QsT0FBTyxRQUFRLENBQUM7SUFDcEIsQ0FBQztDQUNKIn0=