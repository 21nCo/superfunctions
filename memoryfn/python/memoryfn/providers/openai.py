from typing import List
from openai import AsyncOpenAI

class OpenAIProvider:
    def __init__(self, api_key: str, embedding_model: str, llm_model: str):
        self.client = AsyncOpenAI(api_key=api_key)
        self.embedding_model = embedding_model
        self.llm_model = llm_model

    async def embed(self, text: str) -> List[float]:
        resp = await self.client.embeddings.create(
            model=self.embedding_model,
            input=text
        )
        return resp.data[0].embedding

    async def embed_batch(self, texts: List[str]) -> List[List[float]]:
        resp = await self.client.embeddings.create(
            model=self.embedding_model,
            input=texts
        )
        return [d.embedding for d in resp.data]

    async def generate_json(self, prompt: str) -> dict:
        resp = await self.client.chat.completions.create(
            model=self.llm_model,
            messages=[
                {"role": "system", "content": "You are a helpful assistant that outputs JSON."},
                {"role": "user", "content": prompt}
            ],
            response_format={"type": "json_object"}
        )
        import json
        return json.loads(resp.choices[0].message.content)
