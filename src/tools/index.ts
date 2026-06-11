/**
 * Local, hand-written tools shared by the agent demos.
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";

/** Evaluate a basic arithmetic expression like "23 * 17". */
export const calculator = tool(
  async ({ expression }: { expression: string }): Promise<string> => {
    // Demo-only: reject anything that isn't digits/operators/parens/decimal/space.
    if (!/^[0-9+\-*/().\s]+$/.test(expression)) {
      return `Refusing to evaluate unsafe expression: ${expression}`;
    }
    try {
      const result = Function(`"use strict"; return (${expression});`)();
      return String(result);
    } catch {
      return `Could not evaluate: ${expression}`;
    }
  },
  {
    name: "calculator",
    description: "Evaluate a basic arithmetic expression, e.g. '23 * 17'.",
    schema: z.object({
      expression: z.string().describe("an arithmetic expression"),
    }),
  },
);

/** Look up the (fake) current weather for a city. */
export const getWeather = tool(
  async ({ city }: { city: string }): Promise<string> => {
    const data: Record<string, string> = {
      Paris: "18°C, cloudy",
      London: "15°C, light rain",
      Tokyo: "24°C, clear",
      "New York": "21°C, sunny",
    };
    return data[city] ?? `No weather data available for ${city}.`;
  },
  {
    name: "get_weather",
    description: "Get the current weather for a city by name.",
    schema: z.object({
      city: z.string().describe("the city name, e.g. 'Paris'"),
    }),
  },
);

export const sayWelcome = tool(
  (): string => "How are you!",
  {
    name: "welcome",
    description: "Return a friendly welcome greeting for visitors.",
    schema: z.object({}),
  },
);

export const localTools = [calculator, getWeather, sayWelcome];
