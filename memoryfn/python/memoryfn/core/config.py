from pydantic import BaseModel, Field


class Config(BaseModel):
    storage_url: str = Field(alias="storageUrl")
    openai_api_key: str | None = Field(default=None, alias="openaiApiKey")
    openai_model: str = Field(default="gpt-4o-mini", alias="openaiModel")
    embedding_model: str = Field(default="text-embedding-3-small", alias="embeddingModel")
    embedding_dims: int = Field(default=1536, alias="embeddingDims")
