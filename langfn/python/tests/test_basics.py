import pytest
import asyncio
from langfn import LangFn
from langfn.models.mock import MockChatModel
from langfn.orchestration.chain import Chain
from langfn.agents.react import ReActAgent
from langfn.tools.calculator import CalculatorTool

@pytest.mark.asyncio
async def test_basic_chain():
    model = MockChatModel()
    lang = LangFn(model=model)
    
    async def step1(x):
        return f"Processed: {x}"
    
    async def step2(x):
        return f"Final: {x}"

    chain = Chain.sequential([step1, step2])
    
    result = await chain.run("Input")
    assert result == "Final: Processed: Input"

@pytest.mark.asyncio
async def test_react_agent():
    model = MockChatModel()
    lang = LangFn(model=model)
    calc = CalculatorTool()
    
    agent = lang.create_react_agent(tools=[calc])
    assert isinstance(agent, ReActAgent)

@pytest.mark.asyncio
async def test_calculator():
    calc = CalculatorTool()
    result = await calc.run({"expression": "2 + 2 * 5"})
    assert result == "12"
    
    result = await calc.run({"expression": "10 / 2"})
    assert result == "5.0"
