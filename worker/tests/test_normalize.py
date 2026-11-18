import pytest

from fama_worker.normalize import is_ordinal, is_year, normalize


@pytest.mark.parametrize("text, spoken", [
    ("Þann 17. júní 1944 var lýðveldið stofnað.", "Þann sautjánda júní nítján hundruð fjörutíu og fjögur var lýðveldið stofnað."),
    ("Klaustur var stofnað á 13. öld.", "Klaustur var stofnað á þrettándu öld."),
    ("Í Reykjavík búa 147.625 manns.", "Í Reykjavík búa eitt hundrað fjörutíu og sjö þúsund sex hundruð tuttugu og fimm manns."),
    ("Hann fékk 3,5 m.kr. Árið eftir kom hann.", "Hann fékk þrír komma fimm milljónir króna. Árið eftir kom hann."),
    ("Til dæmis t.d. 25% hlut o.s.frv.", "Til dæmis til dæmis tuttugu og fimm prósent hlut og svo framvegis"),
    ("Íbúar voru 302. Þeir bjuggu þar.", "Íbúar voru þrjú hundruð og tveir. Þeir bjuggu þar."),
    ("Hallgrímur (1614–1674) orti.", "Hallgrímur (sextán hundruð og fjórtán til sextán hundruð sjötíu og fjögur) orti."),
])
def test_icelandic(text, spoken):
    assert normalize(text, "is") == spoken


@pytest.mark.parametrize("text, spoken", [
    ("It was completed in 1986.[2]", "It was completed in nineteen eighty-six."),
    ("At 74.5 m tall, the 21st floor.", "At seventy-four point five metres tall, the twenty-first floor."),
    ("Mr. Smith paid $5 million, i.e. 1,234 dollars each.", "Mister Smith paid five million dollars, that is one thousand, two hundred and thirty-four dollars each."),
    ("See https://example.com/x.¹ Then 50% more.", "See. Then fifty percent more."),
])
def test_english(text, spoken):
    assert normalize(text, "en") == spoken


def test_icelandic_ordinals_and_years():
    assert is_ordinal(1) == "fyrsti"
    assert is_ordinal(2, "a") == "annan"
    assert is_ordinal(21) == "tuttugasti og fyrsti"
    assert is_ordinal(125) == "hundraðasti tuttugasti og fimmti"
    assert is_year(1786) == "sautján hundruð áttatíu og sex"
    assert is_year(1805) == "átján hundruð og fimm"
    assert is_year(2025) == "tvö þúsund tuttugu og fimm"


def test_paragraphs_survive():
    assert normalize("One.\n\nTwo.", "en") == "One.\n\nTwo."
