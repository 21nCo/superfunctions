from memoryfn.providers.openai import OpenAIProvider
from typing import List, Dict

class FactExtractor:
    def __init__(self, provider: OpenAIProvider):
        self.provider = provider

    async def extract(self, text: str) -> List[Dict]:
        prompt = f"""
        Analyze the following text and extract discrete, atomic facts. 
        Return a JSON object with a key "facts" containing an array of objects.
        Each object should have:
        - "content": The fact as a standalone sentence.
        - "type": One of "profile_static", "profile_dynamic", "conversational".
        - "confidence": A number between 0 and 1.
        - "tags": Array of relevant keywords.

        Text: "{text}"
        """
        try:
            result = await self.provider.generate_json(prompt)
            return result.get("facts", [])
        except Exception as e:
            print(f"Extraction failed: {e}")
            return []
