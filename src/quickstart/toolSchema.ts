import type { ToolParameterProperty, ToolParameterSchema } from '../runtime-kernel';

function serializeToolProperty(property: ToolParameterProperty): Record<string, unknown> {
  return {
    type: property.type,
    description: property.description,
    ...(property.default !== undefined ? { default: property.default } : {}),
    ...(property.enum !== undefined ? { enum: [...property.enum] } : {}),
    ...(property.properties !== undefined
      ? {
          properties: Object.fromEntries(
            Object.entries(property.properties).map(([key, value]) => [key, serializeToolProperty(value)]),
          ),
        }
      : {}),
    ...(property.items !== undefined ? { items: serializeToolProperty(property.items) } : {}),
    ...(property.required !== undefined ? { required: [...property.required] } : {}),
  };
}

export function serializeToolParameters(schema: ToolParameterSchema): Record<string, unknown> {
  return {
    type: schema.type,
    properties: Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, serializeToolProperty(value)]),
    ),
    ...(schema.required !== undefined ? { required: [...schema.required] } : {}),
    ...(schema.additionalProperties !== undefined
      ? { additionalProperties: schema.additionalProperties }
      : {}),
  };
}
